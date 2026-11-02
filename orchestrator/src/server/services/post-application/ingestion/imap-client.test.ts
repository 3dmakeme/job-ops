import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
    connect: vi.fn(),
    mailboxOpen: vi.fn(),
    search: vi.fn(),
    fetchAll: vi.fn(),
    logout: vi.fn(),
    close: vi.fn(),
    usable: true,
  };
  return {
    instance,
    ImapFlow: vi.fn(function ImapFlow(_options: unknown) {
      return instance;
    }),
  };
});

vi.mock("imapflow", () => ({ ImapFlow: mocks.ImapFlow }));

import {
  createImapClient,
  IMAP_MAX_MESSAGE_BYTES,
  IMAP_MAX_SYNC_BYTES,
  ImapAuthenticationError,
  ImapConnectionError,
} from "./imap-client";

const PASSWORD = "very-secret-password";
const config = {
  host: "mail.example.com",
  port: 993,
  tls: true,
  username: "candidate@example.com",
  password: PASSWORD,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instance.usable = true;
});

describe("imap client", () => {
  it("uses implicit TLS with certificate validation and 15s timeouts", () => {
    createImapClient(config);

    const options = mocks.ImapFlow.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      host: "mail.example.com",
      port: 993,
      secure: true,
      auth: { user: "candidate@example.com", pass: PASSWORD },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      logger: false,
    });
    expect(options).not.toHaveProperty("tls");
    expect(options).not.toHaveProperty("doSTARTTLS");
  });

  it("requires STARTTLS when implicit TLS is off", () => {
    createImapClient({ ...config, port: 143, tls: false });

    expect(mocks.ImapFlow.mock.calls[0]?.[0]).toMatchObject({
      port: 143,
      secure: false,
      doSTARTTLS: true,
    });
  });

  it("maps authentication failures without the server response", async () => {
    mocks.instance.connect.mockRejectedValueOnce(
      Object.assign(new Error(`NO [AUTHENTICATIONFAILED] ${PASSWORD}`), {
        authenticationFailed: true,
        responseText: `bad password ${PASSWORD}`,
      }),
    );

    const error = await createImapClient(config)
      .connect()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ImapAuthenticationError);
    expect(error.message).toBe(
      "IMAP login failed. Check the username and password.",
    );
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
  });

  it("maps network failures to a connection error", async () => {
    mocks.instance.connect.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND mail.example.com"), {
        code: "ENOTFOUND",
      }),
    );

    const error = await createImapClient(config)
      .connect()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ImapConnectionError);
    expect(error.message).toBe(
      "Could not reach the IMAP server at mail.example.com:993.",
    );
    expect(error.code).toBe("ENOTFOUND");
  });

  it("opens INBOX read-only and fetches sources by UID", async () => {
    mocks.instance.mailboxOpen.mockResolvedValueOnce({ uidValidity: 42n });
    mocks.instance.search.mockResolvedValueOnce([1, 2]);
    mocks.instance.fetchAll.mockResolvedValueOnce([
      { uid: 2, source: Buffer.from("raw") },
      { uid: 1 },
    ]);
    const client = createImapClient(config);
    const since = new Date("2026-01-01T00:00:00.000Z");

    await expect(client.openInboxReadOnly()).resolves.toEqual({
      uidValidity: "42",
    });
    await expect(client.searchUidsSince(since)).resolves.toEqual([1, 2]);
    await expect(client.fetchMessageSources([2, 1], 1024)).resolves.toEqual([
      { uid: 2, source: Buffer.from("raw") },
    ]);

    expect(mocks.instance.mailboxOpen).toHaveBeenCalledWith("INBOX", {
      readOnly: true,
    });
    expect(mocks.instance.search).toHaveBeenCalledWith(
      { since },
      { uid: true },
    );
    expect(mocks.instance.fetchAll).toHaveBeenCalledWith(
      [2, 1],
      { uid: true, source: { maxLength: 1024 } },
      { uid: true },
    );
  });

  it("exports a 1 MiB per-message cap and a 32 MiB per-sync budget", () => {
    expect(IMAP_MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(IMAP_MAX_SYNC_BYTES).toBe(32 * 1024 * 1024);
  });

  it("slices a returned source longer than the limit to exactly the limit", async () => {
    mocks.instance.fetchAll.mockResolvedValueOnce([
      { uid: 5, source: Buffer.from("0123456789") },
      { uid: 4, source: Buffer.from("0123") },
    ]);

    const messages = await createImapClient(config).fetchMessageSources(
      [5, 4],
      4,
    );

    expect(mocks.instance.fetchAll).toHaveBeenCalledWith(
      [5, 4],
      { uid: true, source: { maxLength: 4 } },
      { uid: true },
    );
    expect(messages).toEqual([
      { uid: 5, source: Buffer.from("0123") },
      { uid: 4, source: Buffer.from("0123") },
    ]);
    expect(messages[0]?.source).toHaveLength(4);
  });

  it("does not call the server for an empty source fetch", async () => {
    await expect(
      createImapClient(config).fetchMessageSources([], 4),
    ).resolves.toEqual([]);
    expect(mocks.instance.fetchAll).not.toHaveBeenCalled();
  });

  it("fetches message sizes by UID and maps a missing size to null", async () => {
    mocks.instance.fetchAll.mockResolvedValueOnce([
      { uid: 3, size: 2048 },
      { uid: 2 },
    ]);

    await expect(
      createImapClient(config).fetchMessageSizes([3, 2]),
    ).resolves.toEqual([
      { uid: 3, size: 2048 },
      { uid: 2, size: null },
    ]);
    expect(mocks.instance.fetchAll).toHaveBeenCalledWith(
      [3, 2],
      { uid: true, size: true },
      { uid: true },
    );
  });

  it("returns no sizes for an empty UID list without calling the server", async () => {
    await expect(
      createImapClient(config).fetchMessageSizes([]),
    ).resolves.toEqual([]);
    expect(mocks.instance.fetchAll).not.toHaveBeenCalled();
  });

  it("maps a size fetch failure to a connection error", async () => {
    mocks.instance.fetchAll.mockRejectedValueOnce(
      Object.assign(new Error("BAD fetch"), { code: "EPIPE" }),
    );

    const error = await createImapClient(config)
      .fetchMessageSizes([1])
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ImapConnectionError);
    expect(error.message).toBe("IMAP server fetch failed.");
    expect(error.code).toBe("EPIPE");
  });

  it("logs out on close and falls back to closing the socket", async () => {
    mocks.instance.logout.mockRejectedValueOnce(new Error("socket gone"));

    await createImapClient(config).close();

    expect(mocks.instance.logout).toHaveBeenCalledTimes(1);
    expect(mocks.instance.close).toHaveBeenCalledTimes(1);
  });
});
