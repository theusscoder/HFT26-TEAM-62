import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { initTheme } from "./components/ThemePicker";
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
import Reconstruction from "./pages/Reconstruction";
import Ask from "./pages/Ask";
import Response from "./pages/Response";
import TSPoliceDB from "./pages/TSPoliceDB";
import Intercept from "./pages/Intercept";
import Live from "./pages/Live";
import CameraWall from "./pages/CameraWall";
import City from "./pages/City";
import LiveCity from "./pages/LiveCity";
import Operations from "./pages/Operations";
import CityHome from "./pages/CityHome";
import TelegramSetup from "./pages/TelegramSetup";
import Police from "./pages/Police";
import Hospital from "./pages/Hospital";
import DashcamPage, { DashcamIndex } from "./pages/Dashcam";

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CityHome />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="/police" element={<Police />} />
        <Route path="/telegram" element={<TelegramSetup />} />
        <Route path="/hospital" element={<Hospital />} />
        <Route path="/overview" element={<LiveCity />} />
        <Route path="/cases" element={<Home />} />
        <Route path="/new" element={<NewCase />} />
        <Route path="/ts-police-db" element={<div className="h-full overflow-auto p-6"><TSPoliceDB /></div>} />
        <Route path="/live" element={<Live />} />
        <Route path="/cameras" element={<CameraWall />} />
        <Route path="/city" element={<City />} />
        <Route path="/dashcam" element={<DashcamIndex />} />
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
          <Route path="reconstruction" element={<Reconstruction />} />
          <Route path="ask" element={<Ask />} />
          <Route path="response" element={<Response />} />
          <Route path="ts-police-db" element={<TSPoliceDB />} />
          <Route path="intercept" element={<Intercept />} />
          <Route path="dashcam" element={<DashcamPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
