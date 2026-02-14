const DEFAULT_SETTINGS = {
  protectedDomains: ["cinefreak.net"],
};

const addDomainForm = document.getElementById("addDomainForm");
const domainInput = document.getElementById("domainInput");
const domainList = document.getElementById("domainList");
const optionsStatus = document.getElementById("optionsStatus");

void initOptions();

async function initOptions() {
  addDomainForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void addDomain();
  });

  await renderDomainList();
}

async function addDomain() {
  const normalized = normalizeDomainInput(domainInput.value);
  if (!normalized) {
    showStatus("Enter a valid domain like example.com");
    return;
  }

  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const domains = Array.isArray(settings.protectedDomains)
    ? settings.protectedDomains.map((entry) => normalizeDomainInput(entry)).filter(Boolean)
    : [...DEFAULT_SETTINGS.protectedDomains];

  if (domains.includes(normalized)) {
    showStatus(`Domain already exists: ${normalized}`);
    return;
  }

  domains.push(normalized);
  domains.sort();

  await chrome.storage.local.set({ protectedDomains: domains });

  domainInput.value = "";
  showStatus(`Added ${normalized}`);
  await renderDomainList();
}

async function removeDomain(domain) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const domains = Array.isArray(settings.protectedDomains)
    ? settings.protectedDomains
        .map((entry) => normalizeDomainInput(entry))
        .filter((entry) => entry && entry !== domain)
    : [];

  await chrome.storage.local.set({ protectedDomains: domains });
  showStatus(`Removed ${domain}`);
  await renderDomainList();
}

async function renderDomainList() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const domains = Array.isArray(settings.protectedDomains)
    ? settings.protectedDomains.map((entry) => normalizeDomainInput(entry)).filter(Boolean)
    : [...DEFAULT_SETTINGS.protectedDomains];

  domains.sort();

  domainList.textContent = "";

  if (domains.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "No domains configured.";
    domainList.appendChild(empty);
    return;
  }

  for (const domain of domains) {
    const item = document.createElement("li");
    item.className = "domain-item";

    const name = document.createElement("code");
    name.textContent = domain;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "small";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      void removeDomain(domain);
    });

    item.appendChild(name);
    item.appendChild(removeButton);
    domainList.appendChild(item);
  }
}

function normalizeDomainInput(input) {
  if (!input || typeof input !== "string") {
    return "";
  }

  let value = input.trim().toLowerCase();
  if (!value) {
    return "";
  }

  if (value.includes("://")) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch (error) {
      return "";
    }
  }

  value = value.replace(/^\.+/, "").replace(/\.+$/, "");
  value = value.replace(/\/.*$/, "");

  if (!/^[a-z0-9.-]+$/.test(value)) {
    return "";
  }

  if (!value.includes(".")) {
    return "";
  }

  return value;
}

function showStatus(message) {
  optionsStatus.textContent = message;
}
