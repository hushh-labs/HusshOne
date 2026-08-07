import type { MetadataRoute } from "next";

/* Installable app: "Add to Home Screen" on iPhone/iPad/Android, installable on
   macOS/Windows browsers. Adam is the front door. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Adam — One by hussh",
    short_name: "Adam",
    description: "Your phone is a supercomputer. Adam runs your biggest work where it finishes best.",
    id: "/adam",
    start_url: "/adam",
    display: "standalone",
    orientation: "portrait",
    // Summer White is the reference appearance; dark follows the device via CSS.
    background_color: "#fbfbfd",
    theme_color: "#fbfbfd",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
