const passwordInput = document.getElementById("password");
const passwordToggle = document.getElementById("password-toggle");
const dropinPanel = document.querySelector(".login-dropin-panel");
const dropinReplay = document.getElementById("login-dropin-replay");

passwordToggle.addEventListener("click", () => {
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  passwordToggle.textContent = isVisible ? "Show" : "Hide";
  passwordToggle.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
});

dropinReplay.addEventListener("click", () => {
  dropinPanel.classList.remove("login-dropin-run");
  void dropinPanel.offsetWidth;
  dropinPanel.classList.add("login-dropin-run");
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: {
        identifier: document.getElementById("matric").value.trim(),
        password: document.getElementById("password").value,
      },
    });

    const role = result?.student?.role;
    if (role === "ADMIN" || role === "ELECTION_OFFICER") {
      window.location.href = "/pages/admin.html";
      return;
    }

    window.location.href = "/pages/vote.html";
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
