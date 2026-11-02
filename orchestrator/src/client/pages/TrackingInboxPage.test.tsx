import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as api from "../api";
import { renderWithQueryClient } from "../test/renderWithQueryClient";
import { TrackingInboxPage } from "./TrackingInboxPage";

const render = (ui: Parameters<typeof renderWithQueryClient>[0]) =>
  renderWithQueryClient(ui);

vi.mock("../api", () => ({
  postApplicationProviderStatus: vi.fn(),
  getPostApplicationInbox: vi.fn(),
  getPostApplicationRuns: vi.fn(),
  getJobs: vi.fn(),
  approvePostApplicationInboxItem: vi.fn(),
  denyPostApplicationInboxItem: vi.fn(),
  getPostApplicationRunMessages: vi.fn(),
  postApplicationGmailOauthStart: vi.fn(),
  postApplicationGmailOauthExchange: vi.fn(),
  postApplicationProviderSync: vi.fn(),
  postApplicationProviderDisconnect: vi.fn(),
  postApplicationProviderConnect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}));

function makeInboxItem() {
  return {
    message: {
      id: "msg-1",
      provider: "gmail" as const,
      accountKey: "default",
      integrationId: null,
      syncRunId: null,
      externalMessageId: "ext-1",
      externalThreadId: null,
      fromAddress: "jobs@example.com",
      fromDomain: "example.com",
      senderName: "Recruiting",
      subject: "Interview invite",
      receivedAt: Date.now(),
      snippet: "Let's schedule",
      classificationLabel: "interview",
      classificationConfidence: 0.95,
      classificationPayload: null,
      relevanceLlmScore: 95,
      relevanceDecision: "relevant" as const,
      matchedJobId: "job-2",
      matchConfidence: 95,
      stageTarget: "technical_interview" as const,
      messageType: "interview" as const,
      stageEventPayload: null,
      processingStatus: "pending_user" as const,
      decidedAt: null,
      decidedBy: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    matchedJob: {
      id: "job-2",
      title: "Software Engineer",
      employer: "Example",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(api.postApplicationProviderStatus).mockResolvedValue({
    provider: "gmail",
    action: "status",
    accountKey: "default",
    status: {
      provider: "gmail",
      accountKey: "default",
      connected: true,
      integration: {
        id: "int-1",
        provider: "gmail",
        accountKey: "default",
        displayName: null,
        status: "connected",
        credentials: null,
        lastConnectedAt: null,
        lastSyncedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  vi.mocked(api.getPostApplicationInbox).mockResolvedValue({
    items: [makeInboxItem()],
    total: 1,
  });
  vi.mocked(api.getPostApplicationRuns).mockResolvedValue({
    runs: [],
    total: 0,
  });
  vi.mocked(api.getJobs).mockResolvedValue({
    jobs: [
      {
        id: "job-1",
        source: "manual",
        title: "Software Engineer I",
        employer: "Example",
        jobUrl: "https://example.com/job-1",
        applicationLink: null,
        datePosted: null,
        deadline: null,
        salary: null,
        location: null,
        status: "applied",
        suitabilityScore: null,
        sponsorMatchScore: null,
        jobType: null,
        jobFunction: null,
        salaryMinAmount: null,
        salaryMaxAmount: null,
        salaryCurrency: null,
        discoveredAt: new Date().toISOString(),
        appliedAt: null,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "job-2",
        source: "manual",
        title: "Software Engineer II",
        employer: "Example",
        jobUrl: "https://example.com/job-2",
        applicationLink: null,
        datePosted: null,
        deadline: null,
        salary: null,
        location: null,
        status: "applied",
        suitabilityScore: null,
        sponsorMatchScore: null,
        jobType: null,
        jobFunction: null,
        salaryMinAmount: null,
        salaryMaxAmount: null,
        salaryCurrency: null,
        discoveredAt: new Date().toISOString(),
        appliedAt: null,
        updatedAt: new Date().toISOString(),
      },
    ],
    total: 2,
    byStatus: {
      discovered: 0,
      processing: 0,
      ready: 0,
      applied: 2,
      skipped: 0,
      expired: 0,
    },
    revision: "r1",
  } as Awaited<ReturnType<typeof api.getJobs>>);
  vi.mocked(api.approvePostApplicationInboxItem).mockResolvedValue({
    message: makeInboxItem().message,
    stageEventId: "evt-1",
  });
  vi.mocked(api.denyPostApplicationInboxItem).mockResolvedValue({
    message: {
      ...makeInboxItem().message,
      processingStatus: "ignored",
      matchedJobId: null,
    },
  });
  vi.mocked(api.getPostApplicationRunMessages).mockResolvedValue({
    run: {
      id: "run-1",
      provider: "gmail",
      accountKey: "default",
      integrationId: null,
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      messagesDiscovered: 1,
      messagesRelevant: 1,
      messagesClassified: 1,
      messagesMatched: 1,
      messagesApproved: 0,
      messagesDenied: 0,
      messagesErrored: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    items: [makeInboxItem()],
    total: 1,
  });
});

describe("TrackingInboxPage", () => {
  it("renders pending messages", async () => {
    render(
      <MemoryRouter>
        <TrackingInboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Interview invite")).toBeInTheDocument();
    });
  });

  it("submits approve action", async () => {
    render(
      <MemoryRouter>
        <TrackingInboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Interview invite")).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm email-job match" }),
    );

    await waitFor(() => {
      expect(api.approvePostApplicationInboxItem).toHaveBeenCalled();
    });
    expect(api.approvePostApplicationInboxItem).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-2",
      }),
    );
  });

  it("loads dropdown jobs excluding discovered status", async () => {
    render(
      <MemoryRouter>
        <TrackingInboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(api.getJobs).toHaveBeenCalledWith({
        statuses: ["applied", "in_progress"],
        view: "list",
      });
    });
  });
});

function mockImapStatus(input: {
  connected: boolean;
  credentials?: Record<string, unknown> | null;
}) {
  const gmailStatus = vi.mocked(api.postApplicationProviderStatus);
  const defaultImplementation = gmailStatus.getMockImplementation();
  gmailStatus.mockImplementation(async (args) => {
    if (args?.provider !== "imap") {
      return defaultImplementation
        ? defaultImplementation(args)
        : Promise.reject(new Error("missing status mock"));
    }
    return {
      provider: "imap",
      action: "status",
      accountKey: "default",
      status: {
        provider: "imap",
        accountKey: "default",
        connected: input.connected,
        integration: input.connected
          ? {
              id: "int-imap",
              provider: "imap",
              accountKey: "default",
              displayName: "candidate@example.com",
              status: "connected",
              credentials: input.credentials ?? null,
              lastConnectedAt: null,
              lastSyncedAt: null,
              lastError: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : null,
      },
    };
  });
}

async function selectImapProvider() {
  render(
    <MemoryRouter>
      <TrackingInboxPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
  fireEvent.click(await screen.findByRole("option", { name: "imap" }));
  return screen.findByLabelText("Host");
}

function fillImapForm(values: {
  host?: string;
  port?: string;
  username?: string;
  password?: string;
}) {
  if (values.host !== undefined) {
    fireEvent.change(screen.getByLabelText("Host"), {
      target: { value: values.host },
    });
  }
  if (values.port !== undefined) {
    fireEvent.change(screen.getByLabelText("Port"), {
      target: { value: values.port },
    });
  }
  if (values.username !== undefined) {
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: values.username },
    });
  }
  if (values.password !== undefined) {
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: values.password },
    });
  }
}

describe("TrackingInboxPage IMAP connect form", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  beforeEach(() => {
    mockImapStatus({ connected: false });
  });

  it("shows the five labelled IMAP fields when imap is selected", async () => {
    await selectImapProvider();

    expect(screen.getByLabelText("Host")).toHaveAttribute(
      "placeholder",
      "mail.example.com",
    );
    expect(screen.getByLabelText("Port")).toHaveValue(993);
    expect(screen.getByLabelText("Use TLS")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Username")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.queryByText(/Gmail connect uses Google OAuth popup/),
    ).not.toBeInTheDocument();
  });

  it("submits the typed payload and clears the password after success", async () => {
    vi.mocked(api.postApplicationProviderConnect).mockResolvedValue({
      provider: "imap",
      action: "connect",
      accountKey: "default",
      status: {
        provider: "imap",
        accountKey: "default",
        connected: true,
        integration: null,
      },
    });
    await selectImapProvider();

    fillImapForm({
      host: "mail.example.com",
      port: "143",
      username: "candidate@example.com",
      password: "imap-password",
    });
    fireEvent.click(screen.getByLabelText("Use TLS"));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(api.postApplicationProviderConnect).toHaveBeenCalledWith({
        provider: "imap",
        accountKey: "default",
        payload: {
          host: "mail.example.com",
          port: 143,
          tls: false,
          username: "candidate@example.com",
          password: "imap-password",
        },
      });
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Provider connected");
    });
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Host")).toHaveValue("mail.example.com");
    expect(api.postApplicationGmailOauthStart).not.toHaveBeenCalled();
  });

  it("blocks submit with an empty password and sends no request", async () => {
    await selectImapProvider();

    fillImapForm({
      host: "mail.example.com",
      username: "candidate@example.com",
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Host, username and password are required for IMAP.",
      );
    });
    expect(api.postApplicationProviderConnect).not.toHaveBeenCalled();
  });

  it("blocks submit with an out-of-range port", async () => {
    await selectImapProvider();

    fillImapForm({
      host: "mail.example.com",
      port: "70000",
      username: "candidate@example.com",
      password: "imap-password",
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Port must be a whole number from 1 to 65535.",
      );
    });
    expect(api.postApplicationProviderConnect).not.toHaveBeenCalled();
  });

  it("keeps host, port and username when connect fails", async () => {
    vi.mocked(api.postApplicationProviderConnect).mockRejectedValue(
      new Error("IMAP login failed. Check the username and password."),
    );
    await selectImapProvider();

    fillImapForm({
      host: "mail.example.com",
      port: "995",
      username: "candidate@example.com",
      password: "wrong-password",
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "IMAP login failed. Check the username and password.",
      );
    });
    expect(screen.getByLabelText("Host")).toHaveValue("mail.example.com");
    expect(screen.getByLabelText("Port")).toHaveValue(995);
    expect(screen.getByLabelText("Username")).toHaveValue(
      "candidate@example.com",
    );
  });

  it("shows the stored username and host when imap is connected", async () => {
    mockImapStatus({
      connected: true,
      credentials: {
        host: "mail.example.com",
        port: 993,
        tls: true,
        username: "candidate@example.com",
        hasPassword: true,
      },
    });
    render(
      <MemoryRouter>
        <TrackingInboxPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    fireEvent.click(await screen.findByRole("option", { name: "imap" }));

    expect(
      await screen.findByText("candidate@example.com @ mail.example.com"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();
  });

  it("still uses the Gmail OAuth flow for gmail", async () => {
    vi.mocked(api.postApplicationProviderStatus).mockResolvedValue({
      provider: "gmail",
      action: "status",
      accountKey: "default",
      status: {
        provider: "gmail",
        accountKey: "default",
        connected: false,
        integration: null,
      },
    });
    vi.mocked(api.postApplicationGmailOauthStart).mockResolvedValue({
      provider: "gmail",
      accountKey: "default",
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
      state: "state-1",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <MemoryRouter>
        <TrackingInboxPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/Gmail connect uses Google OAuth popup/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(api.postApplicationGmailOauthStart).toHaveBeenCalledWith({
        accountKey: "default",
      });
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/auth",
      "gmail-oauth-connect",
      "popup,width=520,height=720",
    );
    expect(api.postApplicationProviderConnect).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
