import React from "react";
import ReactDOM from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import App from "./App";
import { PublicMapViewer } from "./PublicMapViewer";
import "./styles.css";

const isPublicViewerRoute = window.location.pathname === "/viewer";
const RootApp = isPublicViewerRoute ? PublicMapViewer : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
