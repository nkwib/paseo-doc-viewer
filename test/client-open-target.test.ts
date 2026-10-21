import { describe, expect, it, vi } from "vitest";
import { type OpenChoice, type openPreference, openTarget, SIDE_BY_SIDE_MIN_WINDOW } from "../client/open-target";
import { createPanelReader } from "../client/panel-reader";
import { documentScreen } from "../client/recent";
import { viewerSettings } from "../shared/settings";

const CHOICES: readonly (OpenChoice | undefined)[] = [undefined, "unset", "auto", "side", "full"];
const UNDER = SIDE_BY_SIDE_MIN_WINDOW - 1;

describe("openTarget", () => {
  it("opens the full screen on a phone, whatever the panel, choice and window", () => {
    for (const panelVisible of [false, true]) {
      for (const choice of CHOICES) {
        for (const windowWidth of [390, UNDER, SIDE_BY_SIDE_MIN_WINDOW]) {
          expect(openTarget({ compact: true, panelVisible, choice, windowWidth })).toBe("screen");
        }
      }
    }
  });

  it("shows the document in a Documents panel already on screen, whatever the choice and window", () => {
    for (const choice of CHOICES) {
      for (const windowWidth of [UNDER, SIDE_BY_SIDE_MIN_WINDOW]) {
        expect(openTarget({ compact: false, panelVisible: true, choice, windowWidth })).toBe("in-place");
      }
    }
  });

  it.each([
    [undefined, "screen", "explorer"],
    ["unset", "screen", "explorer"],
    ["auto", "screen", "explorer"],
    ["side", "explorer", "explorer"],
    ["full", "screen", "screen"],
  ] as const)("with no panel on screen, choice %s opens %s under 1,100 pt and %s from it", (choice, under, from) => {
    expect(openTarget({ compact: false, panelVisible: false, choice, windowWidth: UNDER })).toBe(under);
    expect(openTarget({ compact: false, panelVisible: false, choice, windowWidth: SIDE_BY_SIDE_MIN_WINDOW })).toBe(from);
  });
});

type Read = Parameters<typeof openPreference.read>[0];
type Write = Parameters<typeof openPreference.save>[1];
type Answer = Awaited<ReturnType<Read>>;
const ready = (openDocuments?: string, revision = "1"): Answer =>
  ({ status: "ready", revision, values: openDocuments ? { turnCards: false, kindColors: true, openDocuments } : { turnCards: false, kindColors: true } });
const invalid: Answer = { status: "invalid", revision: "1", error: "bad" };
const offline = () => Promise.reject(new Error("offline"));

// The choice lives in module state shared by every opener and screen, so each test loads a fresh copy.
async function freshPreference() {
  vi.resetModules();
  return (await import("../client/open-target")).openPreference;
}

describe("Open documents setting", () => {
  it("reads a settings file from before the setting as unset, keeping its other values", async () => {
    expect(viewerSettings.schema.parse({ turnCards: false, kindColors: true })).toEqual({ turnCards: false, kindColors: true });
    expect(viewerSettings.schema.parse({})).toEqual({ turnCards: true, kindColors: true });
    const preference = await freshPreference();
    expect(await preference.read(async () => ready())).toBe("unset");
  });

  it("is unknown until a read answers, and a failed or invalid answer keeps what is known", async () => {
    const preference = await freshPreference();
    expect(preference.current()).toBeUndefined();
    expect(await preference.read(offline)).toBeUndefined();
    expect(await preference.read(async () => invalid)).toBeUndefined();
    expect(await preference.read(async () => ready("sideways"))).toBeUndefined();
    expect(await preference.read(async () => ready("side"))).toBe("side");
    expect(await preference.read(offline)).toBe("side");
    expect(await preference.read(async () => ready("sideways"))).toBe("side");
  });

  it("asks once: a read that started before the answer was saved does not bring the question back", async () => {
    const preference = await freshPreference();
    expect(await preference.read(async () => ready())).toBe("unset");
    let answer!: (value: Answer) => void;
    const stale = preference.read(() => new Promise((resolve) => (answer = resolve)));
    preference.set("full");
    answer(ready());
    expect(await stale).toBe("full");
    expect(await preference.read(async () => ready("full"))).toBe("full");
  });

  it("saves on top of the values read, and reads again once after a conflict", async () => {
    const preference = await freshPreference();
    const answers = [ready(undefined, "1"), ready(undefined, "2")];
    const write = vi.fn<Write>(async ({ revision }) =>
      revision === "2" ? { status: "saved", revision: "3", values: {} } : { status: "conflict", error: "stale" });
    expect(await preference.save(async () => answers.shift()!, write, "side")).toBe(true);
    expect(write.mock.calls.map(([input]) => input)).toEqual([
      { revision: "1", values: { turnCards: false, kindColors: true, openDocuments: "side" } },
      { revision: "2", values: { turnCards: false, kindColors: true, openDocuments: "side" } },
    ]);
    expect(preference.current()).toBe("side");
  });

  it("keeps the question after a second conflict, an invalid file or a refused write", async () => {
    const preference = await freshPreference();
    await preference.read(async () => ready());
    const conflict = vi.fn<Write>(async () => ({ status: "conflict", error: "stale" }));
    expect(await preference.save(async () => ready(), conflict, "full")).toBe(false);
    expect(conflict).toHaveBeenCalledTimes(2);
    const unused = vi.fn<Write>();
    expect(await preference.save(async () => invalid, unused, "full")).toBe(false);
    expect(await preference.save(async () => ready("sideways"), unused, "full")).toBe(false);
    expect(unused).not.toHaveBeenCalled();
    expect(await preference.save(async () => ready(), async () => ({ status: "invalid", error: "bad" }), "full")).toBe(false);
    expect(preference.current()).toBe("unset");
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function freshRouting(windowWidth: number, read: Read) {
  vi.resetModules();
  const { createDocumentRouting } = await import("../client/open-target");
  const reader = (await import("../client/panel-reader")).createPanelReader();
  const host = { openScreen: vi.fn(), openPanel: vi.fn(), readSettings: vi.fn(read), windowWidth: () => windowWidth };
  return { ...createDocumentRouting(host, reader), host, reader };
}

describe("document routing", () => {
  const report = documentScreen("ws", "report.pdf", ["notes.docx", "report.pdf"]);
  const selection = { path: "report.pdf", siblings: report.params!.siblings };

  it("opens a phone's document screen at once, without reading the setting", async () => {
    const card = await freshRouting(1440, async () => ready("side"));
    card.openDocument(report, { compact: true });
    expect(card.host.openScreen).toHaveBeenCalledWith(report);
    const command = await freshRouting(600, async () => ready("side"));
    command.openDocument(report);
    expect(command.host.openScreen).toHaveBeenCalledWith(report);
    for (const { host } of [card, command]) {
      expect(host.openPanel).not.toHaveBeenCalled();
      expect(host.readSettings).not.toHaveBeenCalled();
    }
  });

  it("waits for the first read on a wide window, then follows it", async () => {
    const auto = await freshRouting(SIDE_BY_SIDE_MIN_WINDOW, async () => ready());
    auto.openDocument(report);
    expect(auto.host.openPanel).not.toHaveBeenCalled();
    await settle();
    expect(auto.host.openPanel).toHaveBeenCalledWith("documents", { workspaceId: "ws", location: "explorer" });
    expect(auto.reader.get("ws")).toEqual(selection);
    expect(auto.host.openScreen).not.toHaveBeenCalled();
    const narrow = await freshRouting(UNDER, async () => ready());
    narrow.openDocument(report);
    await settle();
    expect(narrow.host.openScreen).toHaveBeenCalledWith(report);
    expect(narrow.reader.get("ws")).toBeNull();
  });

  it("opens at once with the choice known, and the read picks up a change made on another client", async () => {
    const answers = [ready("full"), ready("side"), ready("side")];
    const routing = await freshRouting(1440, async () => answers.shift()!);
    routing.openDocument(report);
    await settle();
    routing.openDocument(report);
    expect(routing.host.openScreen).toHaveBeenCalledTimes(2);
    await settle();
    routing.openDocument(report);
    expect(routing.host.openPanel).toHaveBeenCalledWith("documents", { workspaceId: "ws", location: "explorer" });
    expect(routing.host.readSettings).toHaveBeenCalledTimes(3);
  });

  it("shows the document in a Documents panel already on screen, with no navigation", async () => {
    const routing = await freshRouting(1440, async () => ready("full"));
    routing.reader.measured({}, "ws", 320);
    routing.openDocument(report);
    await settle();
    expect(routing.reader.get("ws")).toEqual(selection);
    expect(routing.host.openScreen).not.toHaveBeenCalled();
    expect(routing.host.openPanel).not.toHaveBeenCalled();
  });

  it("opens other screens as asked", async () => {
    const routing = await freshRouting(1440, async () => ready("side"));
    const review = { screenId: "review", params: { workspaceId: "ws" } };
    routing.openDocument(review);
    expect(routing.host.openScreen).toHaveBeenCalledWith(review);
  });

  it("shows the Documents list, not the document read there last", async () => {
    const routing = await freshRouting(1440, async () => ready("side"));
    routing.reader.select("ws", selection);
    routing.showDocuments("ws");
    expect(routing.reader.get("ws")).toBeNull();
    expect(routing.host.openPanel).toHaveBeenCalledWith("documents", { workspaceId: "ws" });
  });
});

describe("panel reader visibility", () => {
  it("counts a mounted Documents panel as on screen only while it has a width", () => {
    const reader = createPanelReader();
    const panel = {};
    expect(reader.visible("ws")).toBe(false);
    reader.measured(panel, "ws", 320);
    expect(reader.visible("ws")).toBe(true);
    expect(reader.visible("other")).toBe(false);
    reader.measured(panel, "ws", 0);
    expect(reader.visible("ws")).toBe(false);
    reader.measured(panel, "ws", 560);
    reader.unmounted(panel);
    expect(reader.visible("ws")).toBe(false);
  });
});
