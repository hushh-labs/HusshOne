import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OneExperience from "./OneExperience";

describe("OneExperience", () => {
  it("renders the One landing with Google sign-in", () => {
    render(<OneExperience />);

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with apple/i })).not.toBeInTheDocument();
    // exact-match the visible lead, not the sr-only h1 which also contains the phrase
    expect(screen.getByText("Your personal intelligence agent.")).toBeInTheDocument();
  });
});
