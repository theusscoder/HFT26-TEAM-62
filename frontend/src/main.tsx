import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import CaseLayout from "./components/CaseLayout";
import Home from "./pages/Home";
import NewCase from "./pages/NewCase";
import Overview from "./pages/Overview";
import Replay from "./pages/Replay";
import Timeline from "./pages/Timeline";
import Courtroom from "./pages/Courtroom";
import Avoidable from "./pages/Avoidable";
import GoldenHour from "./pages/GoldenHour";
import Pursuit from "./pages/Pursuit";
import Report from "./pages/Report";
import Calibrate from "./pages/Calibrate";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewCase />} />
        <Route path="/case/:id" element={<CaseLayout />}>
          <Route index element={<Overview />} />
          <Route path="golden-hour" element={<GoldenHour />} />
          <Route path="replay" element={<Replay />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="courtroom" element={<Courtroom />} />
          <Route path="avoidable" element={<Avoidable />} />
          <Route path="pursuit" element={<Pursuit />} />
          <Route path="report" element={<Report />} />
          <Route path="calibrate" element={<Calibrate />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
