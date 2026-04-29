const loginForm = document.getElementById("loginForm");
const loginPanel = document.getElementById("loginPanel");
const registerPanel = document.getElementById("registerPanel");
const registerForm = document.getElementById("registerForm");
const showRegisterBtn = document.getElementById("showRegisterBtn");
const showLoginBtn = document.getElementById("showLoginBtn");
const registerMessage = document.getElementById("registerMessage");
const dashboard = document.getElementById("dashboard");
const logoutBtn = document.getElementById("logoutBtn");
const openAddDevice = document.getElementById("openAddDevice");
const deviceModal = document.getElementById("deviceModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const closeModalBackdrop = document.getElementById("closeModalBackdrop");
const deviceForm = document.getElementById("deviceForm");
const deviceMessage = document.getElementById("deviceMessage");
const deviceList = document.getElementById("deviceList");
const template = document.getElementById("deviceCardTemplate");
const onlineCount = document.getElementById("onlineCount");
const activeRelayCount = document.getElementById("activeRelayCount");

const API_BASE_URL = `${window.location.origin}/api`;

const devices = [];
let sessionToken = "";
let currentUser = null;

function setSession(token, user) {
  sessionToken = token;
  currentUser = user;
}

async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  return data;
}

function showLogin() {
  registerPanel.classList.add("hidden");
  dashboard.classList.add("hidden");
  loginPanel.classList.remove("hidden");
}

function showRegister() {
  loginPanel.classList.add("hidden");
  registerPanel.classList.remove("hidden");
}

function updateStats() {
  onlineCount.textContent = devices.filter((device) => device.online).length;
  activeRelayCount.textContent = devices.filter((device) => device.relay).length;
}

async function sendDeviceCommand(device, action) {
  const data = await apiRequest(`/devices/${encodeURIComponent(device.serial)}/command`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });

  device.relay = data.result.relay;
  device.online = data.result.wifiConnected;
}

async function fetchDeviceStatus(device) {
  const data = await apiRequest(`/devices/${encodeURIComponent(device.serial)}/status`);
  device.relay = data.status.relay;
  device.online = data.status.wifiConnected;
}

function renderDevices() {
  deviceList.innerHTML = "";

  devices.forEach((device) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const name = node.querySelector(".device-name");
    const meta = node.querySelector(".device-meta");
    const badge = node.querySelector(".status-badge");
    const onButton = node.querySelector(".btn-device-on");
    const offButton = node.querySelector(".btn-device-off");
    const toggleButton = node.querySelector(".btn-device-toggle");

    name.textContent = device.name;
    meta.textContent = `${device.serial} • Relay ${device.relay ? "ON" : "OFF"} • ${device.ip || "-"}`;
    badge.textContent = device.online ? "Online" : "Offline";
    badge.classList.add(device.online ? "online" : "offline");

    onButton.addEventListener("click", async () => {
      try {
        await sendDeviceCommand(device, "on");
        renderDevices();
      } catch (error) {
        alert(`ON failed for ${device.name}: ${error.message}`);
      }
    });

    offButton.addEventListener("click", async () => {
      try {
        await sendDeviceCommand(device, "off");
        renderDevices();
      } catch (error) {
        alert(`OFF failed for ${device.name}: ${error.message}`);
      }
    });

    toggleButton.addEventListener("click", async () => {
      try {
        await sendDeviceCommand(device, "toggle");
        renderDevices();
      } catch (error) {
        alert(`TOGGLE failed for ${device.name}: ${error.message}`);
      }
    });

    deviceList.appendChild(node);
  });

  updateStats();
}

function openModal() {
  deviceModal.classList.remove("hidden");
}

function closeModal() {
  deviceModal.classList.add("hidden");
  deviceForm.reset();
  deviceMessage.textContent = "Validate a device against backend registry.";
}

async function loadDevicesFromBackend() {
  if (!sessionToken) {
    return;
  }

  const data = await apiRequest("/devices");
  devices.length = 0;

  if (Array.isArray(data.devices)) {
    data.devices.forEach((device, index) => {
      devices.push({
        id: index + 1,
        name: device.deviceName,
        serial: device.deviceId,
        online: true,
        relay: device.relayState === "ON",
        ip: device.deviceIp,
      });
    });
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const password = document.getElementById("password").value;

  try {
    const data = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setSession(data.token, data.user);
    loginPanel.classList.add("hidden");
    registerPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    await loadDevicesFromBackend();
    renderDevices();
  } catch (error) {
    alert(`Login failed: ${error.message}`);
  }
});

logoutBtn.addEventListener("click", () => {
  sessionToken = "";
  currentUser = null;
  devices.length = 0;
  showLogin();
});

openAddDevice.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
closeModalBackdrop.addEventListener("click", closeModal);
showRegisterBtn.addEventListener("click", showRegister);
showLoginBtn.addEventListener("click", showLogin);

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim().toLowerCase();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword = document.getElementById("registerConfirmPassword").value;

  if (password.length < 8) {
    registerMessage.textContent = "Password should be at least 8 characters.";
    return;
  }

  if (password !== confirmPassword) {
    registerMessage.textContent = "Password confirmation does not match.";
    return;
  }

  try {
    await apiRequest("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: name,
        email,
        password,
      }),
    });
    registerMessage.textContent = "Registration completed. You can log in now.";
    registerForm.reset();
  } catch (error) {
    registerMessage.textContent = error.message;
  }
});

deviceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("deviceName").value.trim();
  const serial = document.getElementById("deviceSerial").value.trim().toUpperCase();
  const secret = document.getElementById("deviceSecret").value.trim();

  try {
    await apiRequest("/devices/add", {
      method: "POST",
      body: JSON.stringify({
        deviceId: serial,
        deviceSecret: secret,
        deviceName: name,
      }),
    });

    deviceMessage.textContent = "Device added successfully.";
    await loadDevicesFromBackend();
    renderDevices();
    setTimeout(() => {
      closeModal();
    }, 900);
  } catch (error) {
    deviceMessage.textContent = error.message;
  }
});

async function refreshLiveDevices() {
  for (const device of devices) {
    try {
      await fetchDeviceStatus(device);
    } catch (error) {
      device.online = false;
    }
  }

  if (!dashboard.classList.contains("hidden")) {
    renderDevices();
  }
}

setInterval(refreshLiveDevices, 5000);
