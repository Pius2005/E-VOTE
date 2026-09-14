let sessionId = null;
let electionId = null;
let positionsData = [];
const selections = {}; // positionId -> candidateId

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStep(name) {
  ["otp", "identity", "ballot", "review", "success"].forEach((s) => {
    document.getElementById(`step-${s}`).style.display = s === name ? "block" : "none";
  });
  document.querySelectorAll(".progress-steps .step").forEach((el) => el.classList.remove("active", "done"));
  const order = ["verify", "identity", "vote", "review", "submit"];
  const mapped = { otp: "verify", identity: "identity", ballot: "vote", review: "review", success: "submit" }[name];
  const idx = order.indexOf(mapped);
  order.forEach((o, i) => {
    const el = document.querySelector(`.step[data-step="${o}"]`);
    if (i < idx) el.classList.add("done");
    if (i === idx) el.classList.add("active");
  });
}

async function init() {
  let me;
  try {
    me = await api("/auth/me");
  } catch {
    window.location.href = "/";
    return;
  }
  document.getElementById("student-name").textContent = `Welcome, ${me.student.fullName}`;
  const requestedId = new URLSearchParams(window.location.search).get("electionId");
  const { elections } = await api("/vote/elections/active-for-me");
  const activeElectionIds = new Set((elections || []).map((election) => election.id));
  electionId = requestedId || elections?.[0]?.id;
  if (!electionId || !activeElectionIds.has(electionId)) {
    document.getElementById("otp-error").textContent = "There is no active election you're eligible to vote in right now.";
    return;
  }
  const session = await api(`/vote/elections/${electionId}/session`, { method: "POST" });
  sessionId = session.sessionId;
  await sendOtp();
}

async function sendOtp() {
  const resendBtn = document.getElementById("resend-otp");
  const errorEl = document.getElementById("otp-error");
  resendBtn.disabled = true;
  errorEl.textContent = "";
  try {
    const res = await api(`/vote/sessions/${sessionId}/otp/send`, { method: "POST" });
    startOtpTimer(res.expiresInSeconds, res.resendCooldownSeconds);
  } catch (err) {
    errorEl.textContent = err.message;
    resendBtn.disabled = false;
  }
}

function startOtpTimer(expiresIn, cooldown) {
  const timerEl = document.getElementById("otp-timer");
  const resendBtn = document.getElementById("resend-otp");
  resendBtn.disabled = cooldown > 0;
  let remaining = cooldown;
  timerEl.textContent = expiresIn;
  let expireLeft = expiresIn;
  const interval = setInterval(() => {
    expireLeft -= 1;
    timerEl.textContent = Math.max(expireLeft, 0);
    remaining -= 1;
    if (remaining <= 0) {
      resendBtn.disabled = false;
      clearInterval(interval);
    }
  }, 1000);
}

document.getElementById("resend-otp").addEventListener("click", sendOtp);

document.querySelectorAll(".otp-boxes input").forEach((input, idx, all) => {
  input.addEventListener("input", () => {
    if (input.value && idx < all.length - 1) all[idx + 1].focus();
    if (Array.from(all).every((i) => i.value.length === 1)) submitOtp();
  });
});

async function submitOtp() {
  const code = Array.from(document.querySelectorAll(".otp-boxes input")).map((i) => i.value).join("");
  const errorEl = document.getElementById("otp-error");
  errorEl.textContent = "";
  try {
    await api(`/vote/sessions/${sessionId}/otp/verify`, { method: "POST", body: { code } });
    showStep("identity");
  } catch (err) {
    errorEl.textContent = err.data?.reason === "TOO_MANY_ATTEMPTS"
      ? "Too many incorrect attempts. Request a new code."
      : `${err.message}${err.data?.attemptsLeft !== undefined ? ` (${err.data.attemptsLeft} attempts left)` : ""}`;
    document.querySelectorAll(".otp-boxes input").forEach((i) => (i.value = ""));
    document.querySelector(".otp-boxes input").focus();
  }
}

// --- Identity / camera liveness ---
// Runs a real randomized challenge (blink / turn left / turn right / smile)
// via self-hosted face-api.js, entirely client-side. This is an additional
// authentication factor layered on top of password + OTP, not a sole
// security mechanism — no image or video frame is ever uploaded or stored;
// only the outcome (which challenge was completed) is sent to the server.
document.getElementById("start-camera").addEventListener("click", async () => {
  const video = document.getElementById("camera-view");
  const errorEl = document.getElementById("identity-error");
  const instructionEl = document.getElementById("liveness-instruction");
  errorEl.textContent = "";
  document.getElementById("start-camera").disabled = true;

  try {
    const challenge = await api(`/vote/sessions/${sessionId}/liveness/challenge`, { method: "POST" });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    video.srcObject = stream;
    await new Promise((resolve) => (video.onloadedmetadata = resolve));

    instructionEl.textContent = "Loading verification model…";
    const result = await livenessDetection.runLivenessChallenge(video, (instruction) => {
      instructionEl.textContent = instruction;
    }, challenge.action);

    if (result.completed) {
      await api(`/vote/sessions/${sessionId}/liveness/complete`, {
        method: "POST",
        body: { challengeId: challenge.challengeId, nonce: challenge.nonce, completedAction: result.challenge, liveEmbedding: result.descriptor },
      });
      instructionEl.textContent = "Identity verified.";
      video.srcObject.getTracks().forEach((t) => t.stop());
      await loadBallot();
    } else {
      const reasons = {
        TIMEOUT: "We couldn't confirm the action in time. Please try again in good lighting.",
        NO_FACE_DETECTED: "No face detected. Make sure your face is centered in frame and try again.",
      };
      errorEl.textContent = reasons[result.reason] || "Verification failed. Please try again.";
      document.getElementById("retry-liveness").style.display = "block";
      document.getElementById("start-camera").style.display = "none";
    }
  } catch (err) {
    errorEl.textContent = "Camera access is required to verify your identity. Please allow camera permission.";
    document.getElementById("start-camera").disabled = false;
  }
});

document.getElementById("retry-liveness").addEventListener("click", () => {
  document.getElementById("identity-error").textContent = "";
  document.getElementById("retry-liveness").style.display = "none";
  document.getElementById("start-camera").style.display = "block";
  document.getElementById("start-camera").disabled = false;
  document.getElementById("liveness-instruction").textContent = "Enable your camera to begin";
});

async function loadBallot() {
  const res = await api(`/vote/sessions/${sessionId}/ballot`);
  positionsData = res.positions;
  const container = document.getElementById("positions-container");
  container.replaceChildren();
  positionsData.forEach((position) => {
    const section = document.createElement("div");
    section.appendChild(element("h3", "", position.title.toUpperCase()));
    position.candidates.forEach((c) => {
      const card = document.createElement("label");
      card.className = "candidate-card";
      card.id = `card-${c.id}`;
      const avatar = element("div", "avatar");
      if (c.profilePhotoUrl) {
        const image = document.createElement("img");
        image.src = c.profilePhotoUrl;
        image.alt = "";
        avatar.appendChild(image);
      }
      const details = document.createElement("div");
      details.append(element("div", "name", c.fullName), element("div", "slogan", c.slogan || ""));
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `position-${position.id}`;
      input.value = c.id;
      card.append(avatar, details, input);
      input.addEventListener("change", () => {
        selections[position.id] = c.id;
        document.querySelectorAll(`.candidate-card`).forEach((el) => {
          if (el.querySelector(`input[name="position-${position.id}"]`)) el.classList.remove("selected");
        });
        card.classList.add("selected");
      });
      section.appendChild(card);
    });
    container.appendChild(section);
  });
  showStep("ballot");
}

document.getElementById("to-review").addEventListener("click", () => {
  const errorEl = document.getElementById("ballot-error");
  const missing = positionsData.filter((p) => !selections[p.id]);
  if (missing.length > 0) {
    errorEl.textContent = `Please select a candidate for: ${missing.map((p) => p.title).join(", ")}`;
    return;
  }
  errorEl.textContent = "";
  const reviewContainer = document.getElementById("review-container");
  reviewContainer.replaceChildren();
  positionsData.forEach((p) => {
    const candidate = p.candidates.find((c) => c.id === selections[p.id]);
    const row = document.createElement("div");
    row.style.marginBottom = "12px";
    const name = element("div", "", candidate.fullName);
    name.style.fontWeight = "600";
    row.append(element("div", "muted", p.title), name);
    reviewContainer.appendChild(row);
  });
  showStep("review");
});

document.getElementById("go-back").addEventListener("click", () => showStep("ballot"));

document.getElementById("submit-vote").addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const payload = { selections: Object.entries(selections).map(([positionId, candidateId]) => ({ positionId, candidateId })) };
    const res = await api(`/vote/sessions/${sessionId}/submit`, { method: "POST", body: payload });
    const reference = document.createElement("div");
    reference.append("Reference ID: ", element("strong", "", res.referenceId));
    const submitted = element("div", "", `Submitted: ${new Date(res.submittedAt).toLocaleString()}`);
    document.getElementById("receipt").replaceChildren(reference, submitted);
    showStep("success");
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

init();

// --- Notifications ---
async function loadNotifications() {
  try {
    const res = await api("/notifications");
    const badge = document.getElementById("notif-badge");
    if (res.unreadCount > 0) {
      badge.textContent = res.unreadCount;
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
    const dropdown = document.getElementById("notif-dropdown");
    dropdown.replaceChildren();
    if (res.notifications.length === 0) {
      const empty = element("div", "", "No notifications yet.");
      empty.style.cssText = "padding:14px;color:var(--text-muted);font-size:13px";
      dropdown.appendChild(empty);
    } else {
      res.notifications.forEach((notification) => {
        const item = document.createElement("div");
        item.style.cssText = `padding:12px 14px;border-bottom:1px solid var(--border);${notification.readAt ? "" : "background:#fbf8ee"}`;
        const title = element("div", "", notification.title);
        title.style.cssText = "font-weight:600;font-size:13px";
        item.appendChild(title);
        if (notification.body) {
          const body = element("div", "", notification.body);
          body.style.cssText = "font-size:12px;color:var(--text-muted)";
          item.appendChild(body);
        }
        const date = element("div", "", new Date(notification.createdAt).toLocaleString());
        date.style.cssText = "font-size:11px;color:var(--text-muted);margin-top:4px";
        item.appendChild(date);
        dropdown.appendChild(item);
      });
    }
  } catch {
    // Notifications are non-critical to the voting flow — fail silently.
  }
}

document.getElementById("notif-bell").addEventListener("click", async () => {
  const dropdown = document.getElementById("notif-dropdown");
  const isOpen = dropdown.style.display === "block";
  dropdown.style.display = isOpen ? "none" : "block";
  if (!isOpen) {
    await api("/notifications/read-all", { method: "POST" }).catch(() => {});
    await loadNotifications();
  }
});

loadNotifications();
