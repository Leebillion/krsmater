"use strict";

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("login-error");
  error.textContent = "";
  const response = await fetch("api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "master-reducer" },
    body: JSON.stringify({ password: document.getElementById("password").value }),
  });
  if (response.ok) {
    window.location.href = "./";
    return;
  }
  const body = await response.json().catch(() => ({}));
  error.textContent = body.message || "로그인에 실패했습니다.";
});
