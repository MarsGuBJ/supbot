import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProjectCommissionAgreements, LeasingAPIError, requestJSON } from "./api";
import type { Session } from "./types";

const session: Session = {
  mode: "dev-headers",
  tenantId: "tenant-1",
  organizationId: "org-1",
  departmentId: "dept-1",
  userId: "user-1",
  roleIds: ["leasing-reader"],
};

describe("leasing renderer API adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      supbot: {
        requestLeasing: vi.fn(),
      },
    });
  });

  it("surfaces a server 403 with its response payload", async () => {
    const requestLeasing = window.supbot.requestLeasing as ReturnType<typeof vi.fn>;
    requestLeasing.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { "x-request-id": "req-403" },
      body: { encoding: "json", data: { error: { code: "forbidden", message: "role denied" } } },
    });

    const error = await captureLeasingError(requestJSON("/dashboard", { method: "GET" }, session));
    expect(error).toBeInstanceOf(LeasingAPIError);
    expect(error).toMatchObject({ status: 403, requestId: undefined });
    expect((error as LeasingAPIError).message).toBe("role denied");
    expect(requestLeasing).toHaveBeenCalledWith(expect.objectContaining({ path: "/dashboard", method: "GET" }));
  });

  it("marks optimistic-concurrency responses as conflicts", async () => {
    const requestLeasing = window.supbot.requestLeasing as ReturnType<typeof vi.fn>;
    requestLeasing.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: {},
      body: { encoding: "json", data: { message: "version conflict", requestId: "req-409" } },
    });

    const error = await captureLeasingError(
      requestJSON(
        "/commands/customer.create",
        { method: "POST", body: "{}", headers: { "Idempotency-Key": "key-1" } },
        session,
      ),
    );
    expect(error).toBeInstanceOf(LeasingAPIError);
    expect(error.status).toBe(409);
    expect(error.isConflict).toBe(true);
    expect(error.requestId).toBe("req-409");
  });

  it("treats forbidden commission agreements as unavailable project form data", async () => {
    const requestLeasing = window.supbot.requestLeasing as ReturnType<typeof vi.fn>;
    requestLeasing.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: {},
      body: {
        encoding: "json",
        data: {
          error: {
            code: "command_forbidden",
            message: "authenticated business role cannot execute this leasing command",
          },
        },
      },
    });

    await expect(fetchProjectCommissionAgreements(session)).resolves.toEqual({ items: [], total: 0 });
    expect(requestLeasing).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/commission-agreements", method: "GET" }),
    );
  });
});

async function captureLeasingError(promise: Promise<unknown>): Promise<LeasingAPIError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LeasingAPIError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected leasing request to fail");
}
