import { describe, it, expect } from "vitest";
import { getSuggestions } from "../src/suggestions.js";

describe("getSuggestions", () => {
  it("suggests snapshot for wait command", () => {
    const suggestions = getSuggestions({ command: "wait" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("snapshot");
  });

  it("suggests snapshot for eval command", () => {
    const suggestions = getSuggestions({ command: "eval" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("snapshot");
  });

  it("suggests filling inputs after open", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Sign In"`;
    const suggestions = getSuggestions({ command: "open", snapshot });
    expect(suggestions.some((s) => s.includes("fill"))).toBe(true);
  });

  it("suggests submit after fill", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Submit"`;
    const suggestions = getSuggestions({ command: "fill", snapshot });
    expect(suggestions.some((s) => s.includes("Submit"))).toBe(true);
  });

  it("always includes eval tip", () => {
    const snapshot = `RootWebArea "Page"
  uid=1 textbox "Search"
  uid=2 button "Go"
  uid=3 link "Home"`;
    const suggestions = getSuggestions({ command: "snapshot", snapshot });
    expect(suggestions.some((s) => s.includes("eval"))).toBe(true);
  });

  it("falls back to press Enter when no submit-like button exists", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Cancel"`;
    const suggestions = getSuggestions({ command: "fill", snapshot });
    expect(suggestions.some((s) => s.includes("press Enter"))).toBe(true);
  });

  it("after fill, prefers a non-submit button for the follow-up click", () => {
    // The submit button is already covered by the fill branch's own
    // suggestion, so the generic button hint should offer the other one.
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Sign In"
  uid=3 button "Reset"`;
    const suggestions = getSuggestions({ command: "fill", snapshot });
    expect(suggestions.some((s) => s.includes("Sign In"))).toBe(true);
    expect(suggestions.some((s) => s.includes("Reset"))).toBe(true);
  });

  it("does not suggest the same ref twice", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Submit"`;
    const suggestions = getSuggestions({ command: "fill", snapshot });
    const forRef2 = suggestions.filter((s) => s.includes("@2"));
    expect(forRef2).toHaveLength(1);
  });

  it("suggests clicking a link when the page has one", () => {
    const snapshot = `RootWebArea "Docs"
  uid=1 link "Getting started"`;
    const suggestions = getSuggestions({ command: "open", snapshot });
    expect(
      suggestions.some(
        (s) => s.includes("Getting started") && s.includes("click"),
      ),
    ).toBe(true);
  });

  it("suggests scrolling only once the page has more than five refs", () => {
    const few = `RootWebArea "Small"
  uid=1 link "One"
  uid=2 link "Two"`;
    expect(
      getSuggestions({ command: "open", snapshot: few }).some((s) =>
        s.includes("scroll down"),
      ),
    ).toBe(false);

    const many = `RootWebArea "Big"
  uid=1 link "One"
  uid=2 link "Two"
  uid=3 link "Three"
  uid=4 link "Four"
  uid=5 link "Five"
  uid=6 link "Six"`;
    expect(
      getSuggestions({ command: "open", snapshot: many }).some((s) =>
        s.includes("scroll down"),
      ),
    ).toBe(true);
  });

  it("names axis-browser, not the base tool, in every suggestion", () => {
    const snapshot = `RootWebArea "Page"
  uid=1 textbox "Search"
  uid=2 button "Go"
  uid=3 link "Home"`;
    for (const command of ["open", "fill", "snapshot", "eval", "wait"]) {
      const suggestions = getSuggestions({ command, snapshot });
      expect(suggestions.length).toBeGreaterThan(0);
      for (const s of suggestions) {
        // Assert the positive too: rejecting the old name alone would pass on a
        // suggestion that named neither.
        expect(s).toContain("axis-browser");
        expect(s).not.toContain("chrome-devtools-axi");
      }
    }
  });
});
