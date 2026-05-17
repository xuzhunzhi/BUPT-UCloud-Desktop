// Main entry: tab switching, global state, IPC
window._globalCourseNameOverrides = {};

// Global course name overrides (loaded from prefs)
window._globalCourseNameOverrides = {};

// ===== Tab Switching Engine =====
const tabPanels = document.getElementById("tab-panels");
const tabBtns = document.querySelectorAll(".tab-btn");
const TOTAL_TABS = 4;
const TAB_IDS = ["tab-home", "tab-tasks", "tab-courses", "tab-settings"];

let currentTab = 0;
let scrollPositions = {};

function switchTab(index, instant) {
  if (index < 0 || index >= TOTAL_TABS) return;
  currentTab = index;

  if (instant) tabPanels.classList.add("no-transition");
  tabPanels.style.transform = `translateX(-${index * 100}%)`;
  if (instant) {
    tabPanels.offsetHeight;
    tabPanels.classList.remove("no-transition");
  }

  tabBtns.forEach((btn, i) => {
    btn.classList.toggle("active", i === index);
    btn.setAttribute("aria-selected", i === index ? "true" : "false");
  });

  var panel = document.getElementById(TAB_IDS[index]);
  if (panel && scrollPositions[index] != null) {
    panel.scrollTop = scrollPositions[index];
  }

  // Lazy-load courses on first switch to tab 2
  if (index === 2 && !coursesLoaded) {
    coursesLoaded = true;
    loadCourses();
  }
  // Lazy-load settings on first switch to tab 3
  if (index === 3 && !settingsLoaded) {
    settingsLoaded = true;
    loadSettings().then(function () { setSettingsStatus(""); });
  }
}

function saveScrollPosition() {
  var panel = document.getElementById(TAB_IDS[currentTab]);
  if (panel) scrollPositions[currentTab] = panel.scrollTop;
}

tabBtns.forEach(function (btn) {
  btn.addEventListener("click", function () {
    var idx = parseInt(btn.dataset.tab, 10);
    if (idx !== currentTab) {
      saveScrollPosition();
      switchTab(idx);
    }
  });
});

// ===== iOS Large Title Engine =====
var titleDynamic = document.getElementById("titlebar-dynamic");
var titleStatic = document.getElementById("titlebar-static");
var LARGE_TITLE_RANGE = 76;
var _activeScrollPanel = null;
var _activeHeading = null;
var _onScroll = null;

function updateTitleForTab(index) {
  var panel = document.getElementById(TAB_IDS[index]);
  var heading = panel && panel.querySelector(".tab-heading");
  var title = panel && panel.getAttribute("data-title");

  if (_activeScrollPanel && _onScroll) {
    _activeScrollPanel.removeEventListener("scroll", _onScroll);
  }
  _activeScrollPanel = panel;
  _activeHeading = heading;

  document.querySelectorAll(".tab-heading").forEach(function (h) {
    h.style.transform = "";
  });

  if (!heading) {
    titleStatic.classList.remove("fade-out");
    titleDynamic.style.opacity = "0";
    _onScroll = null;
    return;
  }

  titleDynamic.textContent = title || "";

  _onScroll = function () {
    var st = panel.scrollTop;
    var p = Math.min(st / LARGE_TITLE_RANGE, 1);
    var scale = 1 - p * 0.38;
    var translateY = -p * 42;
    heading.style.transform = "translateY(" + translateY + "px) scale(" + scale + ")";
    heading.style.opacity = 1 - p * 0.6;
    if (p > 0.4) {
      titleStatic.classList.add("fade-out");
      titleDynamic.style.opacity = p;
    } else {
      titleStatic.classList.remove("fade-out");
      titleDynamic.style.opacity = "0";
    }
  };

  _onScroll();
  panel.addEventListener("scroll", _onScroll, { passive: true });
}

var _origSwitchTab = switchTab;
switchTab = function (index, instant) {
  _origSwitchTab(index, instant);
  updateTitleForTab(index);
};

updateTitleForTab(0);

// ===== Swipe (Pointer Events) =====
var swipeStartX = 0;
var swipeDeltaX = 0;
var isSwiping = false;

tabPanels.addEventListener("pointerdown", function (e) {
  swipeStartX = e.clientX;
  swipeDeltaX = 0;
  isSwiping = true;
  tabPanels.classList.add("swiping", "no-transition");
});

tabPanels.addEventListener("pointermove", function (e) {
  if (!isSwiping) return;
  swipeDeltaX = e.clientX - swipeStartX;

  if (Math.abs(swipeDeltaX) < 10) return;

  var maxOffset = (TOTAL_TABS - 1) * 100;
  var baseOffset = currentTab * 100;
  var pixelRatio = (100 / tabPanels.offsetWidth) * swipeDeltaX;
  var newOffset = -baseOffset + pixelRatio;
  newOffset = Math.max(-maxOffset, Math.min(0, newOffset));
  tabPanels.style.transform = "translateX(" + newOffset + "%)";
});

function endSwipe() {
  if (!isSwiping) return;
  isSwiping = false;
  tabPanels.classList.remove("swiping", "no-transition");

  var absDelta = Math.abs(swipeDeltaX);
  if (absDelta > 50) {
    if (swipeDeltaX > 0 && currentTab > 0) {
      saveScrollPosition();
      switchTab(currentTab - 1);
    } else if (swipeDeltaX < 0 && currentTab < TOTAL_TABS - 1) {
      saveScrollPosition();
      switchTab(currentTab + 1);
    }
    // else: invalid direction for edge tab — do nothing
  }
  // else: not a swipe, just a click — do nothing
}

tabPanels.addEventListener("pointerup", endSwipe);
tabPanels.addEventListener("pointerleave", endSwipe);
tabPanels.addEventListener("pointercancel", endSwipe);

// ===== IPC: main process can command a tab switch =====
if (window.buptHw && window.buptHw.onSwitchTab) {
  window.buptHw.onSwitchTab(function (index) {
    saveScrollPosition();
    switchTab(index);
  });
}
