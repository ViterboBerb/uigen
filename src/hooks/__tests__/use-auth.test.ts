import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useAuth } from "@/hooks/use-auth";
import { signIn as signInAction, signUp as signUpAction } from "@/actions";
import { getAnonWorkData, clearAnonWork } from "@/lib/anon-work-tracker";
import { getProjects } from "@/actions/get-projects";
import { createProject } from "@/actions/create-project";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/actions", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("@/lib/anon-work-tracker", () => ({
  getAnonWorkData: vi.fn(),
  clearAnonWork: vi.fn(),
}));

vi.mock("@/actions/get-projects", () => ({
  getProjects: vi.fn(),
}));

vi.mock("@/actions/create-project", () => ({
  createProject: vi.fn(),
}));

const mockSignIn = vi.mocked(signInAction);
const mockSignUp = vi.mocked(signUpAction);
const mockGetAnonWorkData = vi.mocked(getAnonWorkData);
const mockClearAnonWork = vi.mocked(clearAnonWork);
const mockGetProjects = vi.mocked(getProjects);
const mockCreateProject = vi.mocked(createProject);

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: no anon work, no existing projects.
  mockGetAnonWorkData.mockReturnValue(null);
  mockGetProjects.mockResolvedValue([]);
  mockCreateProject.mockResolvedValue({ id: "new-project" } as any);
});

afterEach(() => {
  cleanup();
});

test("exposes signIn, signUp, and isLoading", () => {
  const { result } = renderHook(() => useAuth());

  expect(typeof result.current.signIn).toBe("function");
  expect(typeof result.current.signUp).toBe("function");
  expect(result.current.isLoading).toBe(false);
});

test("isLoading starts as false", () => {
  const { result } = renderHook(() => useAuth());
  expect(result.current.isLoading).toBe(false);
});

// --- signIn ---------------------------------------------------------------

test("signIn returns the action result on success", async () => {
  mockSignIn.mockResolvedValue({ success: true });

  const { result } = renderHook(() => useAuth());

  let returned: unknown;
  await act(async () => {
    returned = await result.current.signIn("user@test.com", "password123");
  });

  expect(mockSignIn).toHaveBeenCalledWith("user@test.com", "password123");
  expect(returned).toEqual({ success: true });
});

test("signIn returns the action result on failure", async () => {
  mockSignIn.mockResolvedValue({ success: false, error: "Invalid credentials" });

  const { result } = renderHook(() => useAuth());

  let returned: unknown;
  await act(async () => {
    returned = await result.current.signIn("user@test.com", "wrong");
  });

  expect(returned).toEqual({ success: false, error: "Invalid credentials" });
});

test("signIn does not run post-sign-in logic when the result is unsuccessful", async () => {
  mockSignIn.mockResolvedValue({ success: false, error: "Invalid credentials" });

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await result.current.signIn("user@test.com", "wrong");
  });

  expect(mockGetAnonWorkData).not.toHaveBeenCalled();
  expect(mockGetProjects).not.toHaveBeenCalled();
  expect(mockCreateProject).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

test("isLoading is true while signIn is in flight and false afterwards", async () => {
  let resolveSignIn: (value: { success: boolean }) => void;
  mockSignIn.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSignIn = resolve;
      })
  );

  const { result } = renderHook(() => useAuth());

  let signInPromise: Promise<unknown>;
  act(() => {
    signInPromise = result.current.signIn("user@test.com", "password123");
  });

  await waitFor(() => expect(result.current.isLoading).toBe(true));

  await act(async () => {
    resolveSignIn!({ success: false });
    await signInPromise;
  });

  expect(result.current.isLoading).toBe(false);
});

test("isLoading is reset to false when the sign-in action throws", async () => {
  mockSignIn.mockRejectedValue(new Error("network failure"));

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await expect(
      result.current.signIn("user@test.com", "password123")
    ).rejects.toThrow("network failure");
  });

  expect(result.current.isLoading).toBe(false);
});

// --- post-sign-in: anonymous work ----------------------------------------

test("converts anonymous work into a project and navigates to it", async () => {
  mockSignIn.mockResolvedValue({ success: true });
  mockGetAnonWorkData.mockReturnValue({
    messages: [{ role: "user", content: "build a button" }],
    fileSystemData: { "/App.jsx": { type: "file", content: "x" } },
  });
  mockCreateProject.mockResolvedValue({ id: "anon-project" } as any);

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await result.current.signIn("user@test.com", "password123");
  });

  expect(mockCreateProject).toHaveBeenCalledWith({
    name: expect.stringContaining("Design from"),
    messages: [{ role: "user", content: "build a button" }],
    data: { "/App.jsx": { type: "file", content: "x" } },
  });
  expect(mockClearAnonWork).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith("/anon-project");
  // Anonymous work short-circuits the existing-project lookup.
  expect(mockGetProjects).not.toHaveBeenCalled();
});

test("ignores anonymous work that has no messages", async () => {
  mockSignIn.mockResolvedValue({ success: true });
  mockGetAnonWorkData.mockReturnValue({
    messages: [],
    fileSystemData: {},
  });
  mockGetProjects.mockResolvedValue([{ id: "existing-project" }] as any);

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await result.current.signIn("user@test.com", "password123");
  });

  expect(mockClearAnonWork).not.toHaveBeenCalled();
  expect(mockGetProjects).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith("/existing-project");
});

// --- post-sign-in: existing projects -------------------------------------

test("navigates to the most recent project when one exists", async () => {
  mockSignIn.mockResolvedValue({ success: true });
  mockGetProjects.mockResolvedValue([
    { id: "recent-project" },
    { id: "older-project" },
  ] as any);

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await result.current.signIn("user@test.com", "password123");
  });

  expect(mockPush).toHaveBeenCalledWith("/recent-project");
  expect(mockCreateProject).not.toHaveBeenCalled();
});

// --- post-sign-in: no work, no projects ----------------------------------

test("creates a fresh project when there is no anon work and no projects", async () => {
  mockSignIn.mockResolvedValue({ success: true });
  mockCreateProject.mockResolvedValue({ id: "fresh-project" } as any);

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await result.current.signIn("user@test.com", "password123");
  });

  expect(mockCreateProject).toHaveBeenCalledWith({
    name: expect.stringContaining("New Design #"),
    messages: [],
    data: {},
  });
  expect(mockClearAnonWork).not.toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/fresh-project");
});

// --- signUp mirrors signIn -----------------------------------------------

test("signUp returns the action result and runs post-sign-in on success", async () => {
  mockSignUp.mockResolvedValue({ success: true });
  mockGetProjects.mockResolvedValue([{ id: "recent-project" }] as any);

  const { result } = renderHook(() => useAuth());

  let returned: unknown;
  await act(async () => {
    returned = await result.current.signUp("new@test.com", "password123");
  });

  expect(mockSignUp).toHaveBeenCalledWith("new@test.com", "password123");
  expect(returned).toEqual({ success: true });
  expect(mockPush).toHaveBeenCalledWith("/recent-project");
});

test("signUp does not run post-sign-in logic when the result is unsuccessful", async () => {
  mockSignUp.mockResolvedValue({ success: false, error: "Email already registered" });

  const { result } = renderHook(() => useAuth());

  let returned: unknown;
  await act(async () => {
    returned = await result.current.signUp("dupe@test.com", "password123");
  });

  expect(returned).toEqual({ success: false, error: "Email already registered" });
  expect(mockGetProjects).not.toHaveBeenCalled();
  expect(mockCreateProject).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

test("isLoading is reset to false when the sign-up action throws", async () => {
  mockSignUp.mockRejectedValue(new Error("server down"));

  const { result } = renderHook(() => useAuth());

  await act(async () => {
    await expect(
      result.current.signUp("new@test.com", "password123")
    ).rejects.toThrow("server down");
  });

  expect(result.current.isLoading).toBe(false);
});
