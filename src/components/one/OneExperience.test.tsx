import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OneExperience from "./OneExperience";

describe("OneExperience", () => {
  it("renders the One landing with Google sign-in", () => {
    render(<OneExperience />);

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with apple/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your personal intelligence agent/i)).toBeInTheDocument();
  });
});
