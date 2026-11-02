import type React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const IMAP_CONNECT_FORM_ID = "imap-connect-form";

export type ImapConnectFormValues = {
  host: string;
  port: string;
  tls: boolean;
  username: string;
  password: string;
};

export const DEFAULT_IMAP_CONNECT_FORM_VALUES: ImapConnectFormValues = {
  host: "",
  port: "993",
  tls: true,
  username: "",
  password: "",
};

export type ImapConnectPayload = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
};

/** Returns the connect payload, or an error message to show instead. */
export function toImapConnectPayload(
  values: ImapConnectFormValues,
): { payload: ImapConnectPayload } | { error: string } {
  const host = values.host.trim();
  const username = values.username.trim();
  const port = Number(values.port.trim());

  if (!host || !username || !values.password) {
    return { error: "Host, username and password are required for IMAP." };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "Port must be a whole number from 1 to 65535." };
  }

  return {
    payload: {
      host,
      port,
      tls: values.tls,
      username,
      password: values.password,
    },
  };
}

type ImapConnectFormProps = {
  values: ImapConnectFormValues;
  onChange: (values: ImapConnectFormValues) => void;
  onSubmit: () => void;
  disabled?: boolean;
};

export const ImapConnectForm: React.FC<ImapConnectFormProps> = ({
  values,
  onChange,
  onSubmit,
  disabled,
}) => {
  const update = (patch: Partial<ImapConnectFormValues>) =>
    onChange({ ...values, ...patch });

  return (
    <form
      id={IMAP_CONNECT_FORM_ID}
      noValidate
      className="grid gap-3 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="imapHost">Host</Label>
        <Input
          id="imapHost"
          placeholder="mail.example.com"
          autoComplete="off"
          value={values.host}
          disabled={disabled}
          onChange={(event) => update({ host: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="imapPort">Port</Label>
          <Input
            id="imapPort"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={values.port}
            disabled={disabled}
            onChange={(event) => update({ port: event.target.value })}
          />
        </div>
        <div className="flex h-9 items-center gap-2">
          <Switch
            id="imapTls"
            checked={values.tls}
            disabled={disabled}
            onCheckedChange={(checked) => update({ tls: checked })}
          />
          <Label htmlFor="imapTls">Use TLS</Label>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="imapUsername">Username</Label>
        <Input
          id="imapUsername"
          autoComplete="username"
          value={values.username}
          disabled={disabled}
          onChange={(event) => update({ username: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="imapPassword">Password</Label>
        <Input
          id="imapPassword"
          type="password"
          autoComplete="current-password"
          value={values.password}
          disabled={disabled}
          onChange={(event) => update({ password: event.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground md:col-span-2">
        IMAP connect verifies the login and stores the password encrypted
        server-side. With TLS off, the connection must upgrade with STARTTLS.
      </p>
    </form>
  );
};
