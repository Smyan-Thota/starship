import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NewChat, type NewChatInput, type NewChatProps } from "../src/components/NewChat.tsx";

afterEach(cleanup);

const repos = [
  { name: "acme", path: "/home/o/acme" },
  { name: "starship", path: "/home/o/starship" },
];

function form(extra: Partial<NewChatProps> = {}) {
  const props: NewChatProps = {
    repos,
    onCreate: async () => null,
    onAddRepo: async () => null,
    onCancel: () => {},
    ...extra,
  };
  return render(<NewChat {...props} />);
}

const title = () => screen.getByLabelText("Title") as HTMLInputElement;
const repo = () => screen.getByLabelText("Repo") as HTMLSelectElement;
const feature = () => screen.getByLabelText("Feature folder") as HTMLInputElement;
const create = () => screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;

describe("fields", () => {
  test("it has Title, Repo, Feature folder and a repo path", () => {
    form();
    expect(title().required).toBe(true);
    expect(repo().tagName).toBe("SELECT");
    expect(feature().tagName).toBe("INPUT");
    screen.getByLabelText("Repo path");
    screen.getByRole("button", { name: "Add repo" });
  });

  test("Repo lists No repo first, then each repo by name", () => {
    form();
    const options = Array.from(repo().options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "No repo"],
      ["acme", "acme"],
      ["starship", "starship"],
    ]);
    expect(repo().value).toBe("");
  });

  test("Feature folder is disabled until a repo is chosen", () => {
    form();
    expect(feature().disabled).toBe(true);
    fireEvent.change(repo(), { target: { value: "acme" } });
    expect(feature().disabled).toBe(false);
    fireEvent.change(repo(), { target: { value: "" } });
    expect(feature().disabled).toBe(true);
  });
});

describe("create", () => {
  test("Create is disabled while the title is empty or only spaces", () => {
    form();
    expect(create().disabled).toBe(true);
    fireEvent.change(title(), { target: { value: "   " } });
    expect(create().disabled).toBe(true);
    fireEvent.change(title(), { target: { value: "Recipe search" } });
    expect(create().disabled).toBe(false);
  });

  test("a chat with no repo sends repo null and feature null", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "  Scratch  " } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({ title: "Scratch", repo: null, feature: null });
  });

  test("a chat on a repo sends the repo and no feature when the field is empty", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Recipe search" } });
    fireEvent.change(repo(), { target: { value: "acme" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({ title: "Recipe search", repo: "acme", feature: null });
  });

  test("a chat on a repo sends the feature folder slug", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Repos command" } });
    fireEvent.change(repo(), { target: { value: "starship" } });
    fireEvent.change(feature(), { target: { value: " v1-repos-command " } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({ title: "Repos command", repo: "starship", feature: "v1-repos-command" });
  });

  test("a feature typed before the repo went back to No repo is not sent", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    fireEvent.change(repo(), { target: { value: "acme" } });
    fireEvent.change(feature(), { target: { value: "recipe-search" } });
    fireEvent.change(repo(), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({ title: "Scratch", repo: null, feature: null });
  });

  test("Enter in the title submits", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    const { container } = form({ onCreate });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test("Create is disabled while the request runs, and a second click sends nothing", async () => {
    let finish: (v: string | null) => void = () => {};
    const onCreate = mock(() => new Promise<string | null>((r) => (finish = r)));
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
    expect(create().disabled).toBe(false);
  });

  test("an error text from the engine shows under the form as is, and the fields keep their values", async () => {
    const onCreate = async () => "Feature folder docs/features/nope/ not found on main";
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Repos command" } });
    fireEvent.change(repo(), { target: { value: "starship" } });
    fireEvent.change(feature(), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.getByRole("alert").textContent).toBe("Feature folder docs/features/nope/ not found on main");
    expect(title().value).toBe("Repos command");
    expect(repo().value).toBe("starship");
    expect(feature().value).toBe("nope");
    expect(create().disabled).toBe(false);
  });

  test("a new attempt clears the old error", async () => {
    const answers: (string | null)[] = ["Slug taken", null];
    const onCreate = async () => answers.shift() ?? null;
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.getByRole("alert").textContent).toBe("Slug taken");
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a request that throws shows an error and enables Create again", async () => {
    form({ onCreate: async () => Promise.reject(new Error("engine down")) });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.getByRole("alert").textContent).toBe("engine down");
    expect(create().disabled).toBe(false);
  });
});

describe("add repo", () => {
  test("Add repo sends the path, and clears the field on success", async () => {
    const onAddRepo = mock(async (_p: string): Promise<string | null> => null);
    form({ onAddRepo });
    const path = screen.getByLabelText("Repo path") as HTMLInputElement;
    fireEvent.change(path, { target: { value: " /home/o/web-shop " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(onAddRepo).toHaveBeenCalledWith("/home/o/web-shop");
    expect(path.value).toBe("");
  });

  test("Add repo is disabled while the path is empty", () => {
    form();
    expect((screen.getByRole("button", { name: "Add repo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("an error text from Add repo shows as is and the path stays", async () => {
    form({ onAddRepo: async () => "Not a git repository" });
    const path = screen.getByLabelText("Repo path") as HTMLInputElement;
    fireEvent.change(path, { target: { value: "/tmp/x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Not a git repository");
    expect(path.value).toBe("/tmp/x");
  });

  test("Add repo does not submit the chat form", async () => {
    const onCreate = mock(async (_i: NewChatInput): Promise<string | null> => null);
    form({ onCreate });
    fireEvent.change(title(), { target: { value: "Scratch" } });
    fireEvent.change(screen.getByLabelText("Repo path"), { target: { value: "/tmp/x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    });
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("cancel and copy", () => {
  test("Cancel calls onCancel", () => {
    const onCancel = mock(() => {});
    form({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("the form shows labels and buttons only, with no sentence of more than 4 words", () => {
    const { container } = form();
    const texts = Array.from(container.querySelectorAll("label, button, option, legend, h1, h2, p")).map((e) => (e.textContent ?? "").trim());
    for (const t of texts) expect(t.split(/\s+/).length).toBeLessThanOrEqual(4);
    expect(container.querySelector("[placeholder]")).toBeNull();
  });
});
