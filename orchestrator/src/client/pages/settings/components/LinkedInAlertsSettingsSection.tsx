import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { LinkedInAlertsValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Link } from "react-router-dom";
import { Checkbox } from "@/components/ui/checkbox";

type LinkedInAlertsSettingsSectionProps = {
  values: LinkedInAlertsValues;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

export const LinkedInAlertsSettingsSection: React.FC<
  LinkedInAlertsSettingsSectionProps
> = ({ values, isLoading, isSaving, layoutMode }) => {
  const { linkedinAlertsEnabled } = values;
  const { control } = useFormContext<UpdateSettingsInput>();

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="LinkedIn Alerts"
      value="linkedin-alerts"
    >
      <div className="flex items-start space-x-3">
        <Controller
          name="linkedinAlertsEnabled"
          control={control}
          render={({ field }) => (
            <Checkbox
              id="linkedinAlertsEnabled"
              checked={field.value ?? linkedinAlertsEnabled.default}
              onCheckedChange={(checked) => {
                field.onChange(
                  checked === "indeterminate" ? null : checked === true,
                );
              }}
              disabled={isLoading || isSaving}
            />
          )}
        />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="linkedinAlertsEnabled"
            className="cursor-pointer text-sm font-medium leading-none"
          >
            Import jobs from LinkedIn alert emails
          </label>
          <p className="text-xs text-muted-foreground">
            During pipeline runs, reads LinkedIn job-alert emails from the last
            7 days in the IMAP account connected on the{" "}
            <Link to="/tracking-inbox" className="underline underline-offset-2">
              Tracking Inbox
            </Link>{" "}
            page and adds their jobs as discovered jobs. Your mailbox is never
            changed.
          </p>
        </div>
      </div>
    </SettingsSectionFrame>
  );
};
