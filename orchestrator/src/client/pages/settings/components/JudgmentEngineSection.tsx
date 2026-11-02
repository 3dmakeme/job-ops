import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { JudgmentEngineValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { JUDGMENT_ENGINE_LABELS, JUDGMENT_ENGINE_VALUES } from "@shared/types.js";
import type React from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type JudgmentEngineSectionProps = {
  values: JudgmentEngineValues;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

type EngineFieldName =
  | "projectSelectionEngine"
  | "emailRoutingEngine"
  | "scoringEngine";

const FIELDS: Array<{
  name: EngineFieldName;
  label: string;
  description: string;
}> = [
  {
    name: "projectSelectionEngine",
    label: "Project selection",
    description:
      "Picks which resume projects fit a job. Jev scores each project against the job description and your code fills the slots; the LLM option asks the model to choose.",
  },
  {
    name: "scoringEngine",
    label: "Job scoring",
    description:
      "Jev scores every job against your resume in about 200 ms. The LLM then only writes the job brief and checks job facts for jobs at or above the brief cutoff; lower-scoring jobs get their brief the first time you open them.",
  },
  {
    name: "emailRoutingEngine",
    label: "Email routing",
    description:
      "Classifies post-application emails and matches them to a job. Jev answers relevance, stage and job separately with calibrated confidence; auto-linking needs all three to be confident.",
  },
];

export const JevBriefCutoffInput: React.FC<{
  values: JudgmentEngineValues;
  disabled: boolean;
}> = ({ values, disabled }) => {
  const { register } = useFormContext<UpdateSettingsInput>();
  return (
    <div className="space-y-2">
      <label htmlFor="jevBriefCutoff" className="text-sm font-medium">
        Brief cutoff (Jev score)
      </label>
      <Input
        id="jevBriefCutoff"
        type="number"
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        {...register("jevBriefCutoff", { valueAsNumber: true })}
      />
      <p className="text-xs text-muted-foreground">
        Jobs scoring below this skip the LLM brief until opened. Effective:{" "}
        {values.jevBriefCutoff.effective} · Default:{" "}
        {values.jevBriefCutoff.default}
      </p>
    </div>
  );
};

export const JudgmentEngineSelect: React.FC<{
  name: EngineFieldName;
  values: JudgmentEngineValues;
  disabled: boolean;
}> = ({ name, values, disabled }) => {
  const { control } = useFormContext<UpdateSettingsInput>();
  const field = FIELDS.find((f) => f.name === name);
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <label htmlFor={`${name}-inline`} className="text-sm font-medium">
        Engine: {field?.label}
      </label>
      <Controller
        name={name}
        control={control}
        render={({ field: formField }) => (
          <Select
            value={formField.value ?? values[name].default}
            onValueChange={formField.onChange}
            disabled={disabled}
          >
            <SelectTrigger id={`${name}-inline`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JUDGMENT_ENGINE_VALUES.map((engine) => (
                <SelectItem key={engine} value={engine}>
                  {JUDGMENT_ENGINE_LABELS[engine]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      <p className="text-xs text-muted-foreground">
        {field?.description} With TypeSafe Jev selected, the model fields below
        are only used as the fallback.
      </p>
    </div>
  );
};

export const JudgmentEngineSection: React.FC<JudgmentEngineSectionProps> = ({
  values,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const { control } = useFormContext<UpdateSettingsInput>();

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="Judgment Engine"
      value="judgment-engines"
    >
      <div className="space-y-5">
        <p className="text-xs text-muted-foreground">
          TypeSafe Jev answers narrow selection and classification questions
          quickly and cheaply. Writing tasks such as summaries, tailoring and
          Ghostwriter always use your configured LLM. Jev needs the{" "}
          <code className="rounded bg-muted px-1 py-0.5">TYPESAFE_API_KEY</code>{" "}
          environment variable on the server; without it, or if a Jev call
          fails, JobOps falls back to the LLM.
        </p>
        {FIELDS.map((field) => (
          <div key={field.name} className="space-y-2">
            <label htmlFor={field.name} className="text-sm font-medium">
              {field.label}
            </label>
            <Controller
              name={field.name}
              control={control}
              render={({ field: formField }) => (
                <Select
                  value={formField.value ?? values[field.name].default}
                  onValueChange={formField.onChange}
                  disabled={isLoading || isSaving}
                >
                  <SelectTrigger id={field.name}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {JUDGMENT_ENGINE_VALUES.map((engine) => (
                      <SelectItem key={engine} value={engine}>
                        {JUDGMENT_ENGINE_LABELS[engine]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              {field.description}
            </p>
            <div className="text-xs text-muted-foreground">
              Effective: {JUDGMENT_ENGINE_LABELS[values[field.name].effective]} ·
              Default: {JUDGMENT_ENGINE_LABELS[values[field.name].default]}
            </div>
            {field.name === "scoringEngine" ? (
              <JevBriefCutoffInput
                values={values}
                disabled={isLoading || isSaving}
              />
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSectionFrame>
  );
};
