import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const MS_IN_DAY = 1000 * 60 * 60 * 24;

const AuthContext = createContext(null);

function toMidnight(dateValue) {
  const date = new Date(dateValue);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonths(dateValue, months) {
  const date = new Date(dateValue);
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function getStatus(expirationDate) {
  const today = toMidnight(new Date());
  const expiration = toMidnight(expirationDate);
  const diffDays = Math.floor((expiration - today) / MS_IN_DAY);

  if (diffDays < 0) {
    return "expired";
  }

  if (diffDays <= 14) {
    return "red";
  }

  const twoMonthsFromNow = addMonths(today, 2);
  if (expiration <= twoMonthsFromNow) {
    return "yellow";
  }

  return "green";
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatDateTime(dateString) {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }

  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function sortByExpiration(items) {
  return [...items].sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate));
}

async function getErrorMessage(response, fallbackMessage) {
  try {
    const body = await response.json();
    return body?.error || fallbackMessage;
  } catch (error) {
    return fallbackMessage;
  }
}

function getTimeUntilExpirationLabel(expirationDate) {
  const today = toMidnight(new Date());
  const expiration = toMidnight(expirationDate);
  const diffDays = Math.floor((expiration - today) / MS_IN_DAY);
  const absDays = Math.abs(diffDays);

  if (diffDays < 0) {
    if (absDays >= 30) {
      const monthsAgo = Math.floor(absDays / 30);
      return `Expired ${monthsAgo} month${monthsAgo === 1 ? "" : "s"} ago`;
    }
    if (absDays >= 7) {
      const weeksAgo = Math.floor(absDays / 7);
      return `Expired ${weeksAgo} week${weeksAgo === 1 ? "" : "s"} ago`;
    }
    return `Expired ${absDays} day${absDays === 1 ? "" : "s"} ago`;
  }

  if (diffDays >= 60) {
    const monthsLeft = Math.floor(diffDays / 30);
    return `${monthsLeft} month${monthsLeft === 1 ? "" : "s"} until expiration`;
  }

  if (diffDays >= 14) {
    const weeksLeft = Math.floor(diffDays / 7);
    return `${weeksLeft} week${weeksLeft === 1 ? "" : "s"} until expiration`;
  }

  if (diffDays === 0) {
    return "Expires today";
  }

  return `${diffDays} day${diffDays === 1 ? "" : "s"} until expiration`;
}

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  async function refreshSession() {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/me`, {
        credentials: "include"
      });

      if (!response.ok) {
        setUser(null);
        return;
      }

      const data = await response.json();
      setUser({ email: data.email });
    } catch (error) {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: "POST",
      credentials: "include"
    });
    setUser(null);
  }

  useEffect(() => {
    refreshSession();
  }, []);

  const authValue = useMemo(
    () => ({
      user,
      authLoading,
      refreshSession,
      logout
    }),
    [user, authLoading]
  );

  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}

function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, authLoading, refreshSession } = useAuth();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authLoading && user) {
      navigate("/dashboard", { replace: true });
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (location.search.includes("expired_or_invalid")) {
      setError("Magic link is invalid or expired. Please request a new one.");
    }
    if (location.search.includes("missing_token")) {
      setError("Missing magic token. Please request a new login link.");
    }
  }, [location.search]);

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    try {
      setSubmitting(true);
      const response = await fetch(`${API_BASE_URL}/auth/request-magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email })
      });

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to request magic link."));
      }

      setMessage("Magic link sent. Check your inbox and click the link within 10 minutes.");
      setEmail("");
      await refreshSession();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="authPage">
      <section className="authCard">
        <h1>Pool Engineering Login</h1>
        <p>Enter your @pooleng.com email to receive a passwordless magic link.</p>
        <form className="authForm" onSubmit={onSubmit}>
          <input
            type="email"
            required
            placeholder="name@pooleng.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? "Sending..." : "Send Magic Link"}
          </button>
        </form>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

function ProtectedRoute({ children }) {
  const { user, authLoading } = useAuth();

  if (authLoading) {
    return <p className="info loadingStandalone">Checking session...</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function DashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [items, setItems] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState(null);

  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    expirationDate: "",
    workspaceId: ""
  });
  const [creating, setCreating] = useState(false);

  const [activeCardId, setActiveCardId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    expirationDate: "",
    workspaceId: ""
  });
  const [updating, setUpdating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [layoutMode, setLayoutMode] = useState("cards");

  async function loadWorkspaces() {
    try {
      setWorkspaceLoading(true);
      const response = await fetch(`${API_BASE_URL}/api/workspaces`, {
        credentials: "include"
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to load workspaces."));
      }

      const data = await response.json();
      setWorkspaces(data);
    } catch (workspaceError) {
      setError(workspaceError.message);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function loadItems(workspaceId = selectedWorkspaceId) {
    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams();
      // When workspaceId is provided, backend filters documents by workspace.
      if (workspaceId) {
        params.set("workspaceId", workspaceId);
      }

      const query = params.toString();
      const response = await fetch(`${API_BASE_URL}/api/documents${query ? `?${query}` : ""}`, {
        credentials: "include"
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to load documents from backend."));
      }

      const data = await response.json();
      setItems(sortByExpiration(data));
    } catch (fetchError) {
      setError(fetchError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkspaces();
  }, []);

  useEffect(() => {
    loadItems(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  const sortedItems = useMemo(() => sortByExpiration(items), [items]);
  const workspaceNameById = useMemo(
    () => Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces]
  );

  function openEditor(item) {
    setError("");
    setActiveCardId(item.id);
    setEditForm({
      name: item.name,
      description: item.description,
      expirationDate: item.expirationDate.slice(0, 10),
      workspaceId: item.workspaceId || ""
    });
  }

  function closeEditor() {
    setActiveCardId(null);
    setEditForm({
      name: "",
      description: "",
      expirationDate: "",
      workspaceId: ""
    });
  }

  async function createWorkspace(event) {
    event.preventDefault();
    const trimmedName = newWorkspaceName.trim();
    if (!trimmedName) {
      setError("Workspace name is required.");
      return;
    }

    try {
      setCreatingWorkspace(true);
      setError("");

      const response = await fetch(`${API_BASE_URL}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: trimmedName })
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to create workspace."));
      }

      setNewWorkspaceName("");
      await loadWorkspaces();
    } catch (workspaceError) {
      setError(workspaceError.message);
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function deleteWorkspace(workspaceId) {
    const confirmed = window.confirm("Delete this workspace?");
    if (!confirmed) {
      return;
    }

    try {
      setDeletingWorkspaceId(workspaceId);
      setError("");

      const response = await fetch(`${API_BASE_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        credentials: "include"
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to delete workspace."));
      }

      const nextSelectedWorkspace = selectedWorkspaceId === workspaceId ? "" : selectedWorkspaceId;
      setSelectedWorkspaceId(nextSelectedWorkspace);
      if (createForm.workspaceId === workspaceId) {
        setCreateForm((current) => ({ ...current, workspaceId: "" }));
      }
      if (editForm.workspaceId === workspaceId) {
        setEditForm((current) => ({ ...current, workspaceId: "" }));
      }

      await loadWorkspaces();
      await loadItems(nextSelectedWorkspace);
    } catch (workspaceError) {
      // Backend returns a specific error when workspace still contains documents.
      setError(workspaceError.message);
    } finally {
      setDeletingWorkspaceId(null);
    }
  }

  async function submitCreate(event) {
    event.preventDefault();
    const { name, description, expirationDate, workspaceId } = createForm;

    if (!name.trim() || !description.trim() || !expirationDate || !workspaceId) {
      setError("Name, description, expiration date, and workspace are required.");
      return;
    }

    try {
      setCreating(true);
      setError("");

      const response = await fetch(`${API_BASE_URL}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          expirationDate,
          workspaceId
        })
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to create this document."));
      }

      setCreateForm({
        name: "",
        description: "",
        expirationDate: "",
        workspaceId: ""
      });
      await loadItems(selectedWorkspaceId);
    } catch (createError) {
      setError(createError.message);
    } finally {
      setCreating(false);
    }
  }

  async function submitUpdate(id) {
    if (!editForm.name.trim() || !editForm.description.trim() || !editForm.expirationDate || !editForm.workspaceId) {
      setError("Name, description, expiration date, and workspace are required.");
      return;
    }

    try {
      setUpdating(true);
      setError("");

      const response = await fetch(`${API_BASE_URL}/api/documents/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim(),
          expirationDate: editForm.expirationDate,
          workspaceId: editForm.workspaceId
        })
      });

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to update this document."));
      }

      closeEditor();
      await loadItems(selectedWorkspaceId);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setUpdating(false);
    }
  }

  async function deleteItem(id) {
    const confirmed = window.confirm("Delete this document permanently?");
    if (!confirmed) {
      return;
    }

    try {
      setDeletingId(id);
      setError("");

      const encodedId = encodeURIComponent(id);
      let response = await fetch(`${API_BASE_URL}/api/documents/${encodedId}`, {
        method: "DELETE",
        credentials: "include"
      });

      if (response.status === 404 || response.status === 405) {
        response = await fetch(`${API_BASE_URL}/api/documents/${encodedId}/delete`, {
          method: "POST",
          credentials: "include"
        });
      }

      if (response.status === 401) {
        navigate("/login", { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response, "Unable to delete this document."));
      }

      if (activeCardId === id) {
        closeEditor();
      }

      await loadItems(selectedWorkspaceId);
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  function renderEditPanel(itemId) {
    return (
      <div className="editPanel" onClick={(event) => event.stopPropagation()}>
        <label htmlFor={`name-${itemId}`}>Name</label>
        <input
          id={`name-${itemId}`}
          type="text"
          value={editForm.name}
          onChange={(event) =>
            setEditForm((current) => ({ ...current, name: event.target.value }))
          }
        />

        <label htmlFor={`description-${itemId}`}>Description</label>
        <input
          id={`description-${itemId}`}
          type="text"
          value={editForm.description}
          onChange={(event) =>
            setEditForm((current) => ({ ...current, description: event.target.value }))
          }
        />

        <label htmlFor={`date-${itemId}`}>Expiration date</label>
        <input
          id={`date-${itemId}`}
          type="date"
          value={editForm.expirationDate}
          onChange={(event) =>
            setEditForm((current) => ({ ...current, expirationDate: event.target.value }))
          }
        />

        <label htmlFor={`workspace-${itemId}`}>Workspace</label>
        <select
          id={`workspace-${itemId}`}
          value={editForm.workspaceId}
          onChange={(event) =>
            setEditForm((current) => ({ ...current, workspaceId: event.target.value }))
          }
        >
          <option value="">Select Workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <div className="actions">
          <button
            className="button"
            type="button"
            disabled={updating}
            onClick={() => submitUpdate(itemId)}
          >
            {updating ? "Saving..." : "Save Changes"}
          </button>
          <button
            className="button danger"
            type="button"
            disabled={deletingId === itemId}
            onClick={() => deleteItem(itemId)}
          >
            {deletingId === itemId ? "Deleting..." : "Delete"}
          </button>
          <button className="button secondary" type="button" onClick={closeEditor}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="page">
      <section className="header headerRow">
        <div className="titleBlock">
          <img
            className="companyLogo"
            src="/pooleng-logo.png"
            alt="Pool Engineering logo"
          />
          <h1>License & Document Expiration Tracker</h1>
        </div>
        <div className="headerMeta">
          <p className="signedInAs">Signed in as {user?.email}</p>
        </div>
        <button className="button secondary" type="button" onClick={handleLogout}>
          Logout
        </button>
      </section>

      <p className="headerSubtitle">Track renewals and prioritize items that are close to expiration.</p>

      <section className="workspacePanel">
        <div className="workspaceHeader">
          <h2>Workspaces</h2>
          <select
            className="workspaceSelect"
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            disabled={workspaceLoading}
          >
            <option value="">All Workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>

        <form className="workspaceCreateForm" onSubmit={createWorkspace}>
          <input
            type="text"
            placeholder="New workspace name"
            value={newWorkspaceName}
            onChange={(event) => setNewWorkspaceName(event.target.value)}
          />
          <button className="button" type="submit" disabled={creatingWorkspace}>
            {creatingWorkspace ? "Creating..." : "Create Workspace"}
          </button>
        </form>

        <ul className="workspaceList">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <span>{workspace.name}</span>
              <button
                className="button danger small"
                type="button"
                disabled={deletingWorkspaceId === workspace.id}
                onClick={() => deleteWorkspace(workspace.id)}
              >
                {deletingWorkspaceId === workspace.id ? "Deleting..." : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="createPanel">
        <h2>Add License / Document</h2>
        <form className="createForm" onSubmit={submitCreate}>
          <input
            type="text"
            placeholder="Name"
            value={createForm.name}
            onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
          />
          <input
            type="text"
            placeholder="Description"
            value={createForm.description}
            onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
          />
          <input
            type="date"
            value={createForm.expirationDate}
            onChange={(event) =>
              setCreateForm((current) => ({ ...current, expirationDate: event.target.value }))
            }
          />
          <select
            value={createForm.workspaceId}
            onChange={(event) => setCreateForm((current) => ({ ...current, workspaceId: event.target.value }))}
          >
            <option value="">Select Workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button className="button" type="submit" disabled={creating || workspaces.length === 0}>
            {creating ? "Adding..." : "Add Item"}
          </button>
        </form>
      </section>

      {loading && <p className="info">Loading records...</p>}
      {error && <p className="error">{error}</p>}

      <section className="resultsToolbar">
        <button
          className="button secondary"
          type="button"
          onClick={() => setLayoutMode((current) => (current === "cards" ? "list" : "cards"))}
        >
          Switch to {layoutMode === "cards" ? "List" : "Cards"} View
        </button>
      </section>

      {layoutMode === "cards" ? (
        <section className="cardGrid">
          {sortedItems.map((item) => {
            const status = getStatus(item.expirationDate);
            const timeUntilExpiration = getTimeUntilExpirationLabel(item.expirationDate);
            const isEditing = activeCardId === item.id;
            const isExpired = status === "expired";

            return (
              <article
                key={item.id}
                className={`card clickable ${status} ${isExpired ? "flash" : ""} ${isEditing ? "editing" : ""}`}
                onClick={() => {
                  if (!isEditing) {
                    openEditor(item);
                  }
                }}
              >
                <h2>{item.name}</h2>
                <p className="description">{item.description}</p>
                <p className="workspaceTag">Workspace: {workspaceNameById[item.workspaceId] || "Unknown"}</p>
                <div className="cardPopover">
                  <p>Created by: {item.createdBy || "Unknown"}</p>
                  <p>Created at: {formatDateTime(item.createdAt)}</p>
                </div>
                <p className="dateLabel">
                  Expires: <strong>{formatDate(item.expirationDate)}</strong>
                </p>
                <p className="statusText">{timeUntilExpiration}</p>
                {!isEditing && <p className="cardHint">Click card to edit or delete</p>}
                {isEditing && renderEditPanel(item.id)}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="listContainer">
          <div className="listHeader">
            <span>Name</span>
            <span>Description</span>
            <span>Workspace</span>
            <span>Expires</span>
            <span>Time Left</span>
            <span>Created By</span>
            <span>Created At</span>
          </div>

          {sortedItems.map((item) => {
            const status = getStatus(item.expirationDate);
            const timeUntilExpiration = getTimeUntilExpirationLabel(item.expirationDate);
            const isEditing = activeCardId === item.id;
            const isExpired = status === "expired";

            return (
              <div key={item.id} className="listItemWrap">
                <div
                  className={`listRow clickable ${status} ${isExpired ? "flash" : ""} ${isEditing ? "editing" : ""}`}
                  onClick={() => {
                    if (!isEditing) {
                      openEditor(item);
                    }
                  }}
                >
                  <span>{item.name}</span>
                  <span>{item.description}</span>
                  <span>{workspaceNameById[item.workspaceId] || "Unknown"}</span>
                  <span>{formatDate(item.expirationDate)}</span>
                  <span>{timeUntilExpiration}</span>
                  <span>{item.createdBy || "Unknown"}</span>
                  <span>{formatDateTime(item.createdAt)}</span>
                </div>
                {isEditing && renderEditPanel(item.id)}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
