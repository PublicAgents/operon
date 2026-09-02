import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { callTool, selectProject, selectedProject, whoami } from "./api.js";
import { PageBoundary } from "./error-boundary.js";
import { AgentsPage } from "./pages/agents.js";
import { ApprovalsPage } from "./pages/approvals.js";
import { AuditPage } from "./pages/audit.js";
import { ChannelPage } from "./pages/channel.js";
import { EventsPage } from "./pages/events.js";
import { LedgersPage } from "./pages/ledgers.js";
import { MessagesPage } from "./pages/messages.js";
import { NotificationsPage } from "./pages/notifications.js";
import { SecretsPage } from "./pages/secrets.js";
import { AsksPage } from "./pages/asks.js";
import { TillPage } from "./pages/till.js";
import { WakesPage } from "./pages/wakes.js";
import { WakeTailPage } from "./pages/wake-tail.js";
import { WebSessionsPage } from "./pages/web.js";
import "./styles.css";

/**
 * Hash routing keeps every SPA location at "/" on the server, so the
 * client can never collide with /api, /mcp, /ws, or a legacy route.
 */

const NAV: { to: string; label: string }[] = [
  { to: "/agents", label: "Agents" },
  { to: "/channel", label: "Channel" },
  { to: "/approvals", label: "Approvals" },
  { to: "/asks", label: "Asks" },
  { to: "/wakes", label: "Wakes" },
  { to: "/events", label: "Events" },
  { to: "/messages", label: "Messages" },
  { to: "/ledgers", label: "Ledgers" },
  { to: "/till", label: "Till" },
  { to: "/web", label: "Browser" },
  { to: "/notifications", label: "Notifications" },
  { to: "/audit", label: "Audit" },
  { to: "/secrets", label: "Secrets" }
];

interface FleetView {
  host: string;
  defaultProject: string;
  projects: { project: string; zone?: string }[];
}

/**
 * The project selector (spec 0006 §9): shown only when the plane
 * reaches more than one project. A change is a whole-console change of
 * context, so the page reloads: every query on screen re-runs against
 * the new selection, nothing stale survives.
 */
function ProjectSelector({ fleet }: { fleet: FleetView }) {
  if (fleet.projects.length < 2) return null;
  const current = selectedProject() ?? fleet.defaultProject;
  return (
    <label className="project" title="Which project this console acts on">
      <select
        value={current}
        onChange={event => {
          const chosen = event.target.value;
          selectProject(chosen === fleet.defaultProject ? undefined : chosen);
          location.reload();
        }}
      >
        {fleet.projects.map(entry => (
          <option key={entry.project} value={entry.project}>
            {entry.project}
            {entry.zone ? ` (${entry.zone})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell() {
  const location = useLocation();
  const [identity, setIdentity] = useState("");
  const [fleet, setFleet] = useState<FleetView | null>(null);
  useEffect(() => {
    whoami()
      .then(who => setIdentity(who.email || who.commonName || who.sub))
      .catch(() => setIdentity(""));
    callTool<FleetView>("fleet_projects")
      .then(setFleet)
      .catch(() => setFleet(null));
  }, []);
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">operon</div>
        {fleet ? <ProjectSelector fleet={fleet} /> : null}
        {NAV.map(item => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
            {item.label}
          </NavLink>
        ))}
        <div className="identity" title="Cloudflare Access identity">
          {identity}
        </div>
      </nav>
      <main className="content">
        <PageBoundary key={location.pathname}>
          <Routes>
          <Route path="/" element={<Navigate to="/agents" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/channel" element={<ChannelPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/wakes" element={<WakesPage />} />
          <Route path="/wakes/:agentId" element={<WakesPage />} />
          <Route path="/wakes/:agentId/:wakeId" element={<WakeTailPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/ledgers" element={<LedgersPage />} />
          <Route path="/asks" element={<AsksPage />} />
          <Route path="/till" element={<TillPage />} />
          <Route path="/web" element={<WebSessionsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/secrets" element={<SecretsPage />} />
          <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        </PageBoundary>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("console root element missing");
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <Shell />
    </HashRouter>
  </StrictMode>
);
