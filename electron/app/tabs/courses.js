// Courses Tab
var coursesLoaded = false;
// ===== Courses Tab (lazy-loaded) =====
var coursesLoaded = false;

function loadCourses() {
  var coursesList = document.getElementById("courses-list");
  var coursesEmpty = document.getElementById("courses-empty");
  var coursesCount = document.getElementById("courses-count");
  var statusCourses = document.getElementById("status-courses");
  var courseDetailEl = document.getElementById("course-detail");
  var courseDetailName = document.getElementById("course-detail-name");
  var courseDetailItems = document.getElementById("course-detail-items");
  var courseDetailBack = document.getElementById("course-detail-back");
  var allCachedItems = [];
  var _savedCourses = [];
  var _courseResources = {};
  var _coursePrefs = {};
  var _editMode = false;
  var _dragSrcIndex = -1;
  var _dragScrollTimer = null;

  function setStatus(text, isErr) {
    statusCourses.textContent = text;
    statusCourses.classList.toggle("err", !!isErr);
  }

  function renderCourses(courses) {
    _savedCourses = courses;
    if (!courses || !courses.length) {
      coursesList.innerHTML = "";
      coursesEmpty.style.display = "flex";
      coursesCount.textContent = "";
      return;
    }

    coursesEmpty.style.display = "none";
    coursesCount.textContent = courses.length + " 门";

    // Build per-course stats from cached items
    var stats = {};
    allCachedItems.forEach(function (it) {
      var c = (it.course || "").trim();
      if (!c) return;
      if (!stats[c]) stats[c] = { total: 0, unsubmitted: 0 };
      stats[c].total++;
      if (!it.submitted) stats[c].unsubmitted++;
    });

    // Apply prefs order: sorted courses first, then new (unsorted) courses at top with badge
    var nameOverride = _coursePrefs.names || {};
    var colorOverride = _coursePrefs.colors || {};
    var prefOrder = _coursePrefs.order || [];

    var sorted = courses.slice().sort(function (a, b) {
      var na = a.siteName || "";
      var nb = b.siteName || "";
      var ia = prefOrder.indexOf(na);
      var ib = prefOrder.indexOf(nb);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0; // keep original order for new courses
    });

    var frag = document.createDocumentFragment();
    sorted.forEach(function (course, i) {
      var origName = course.siteName || "未知课程";
      var displayName = nameOverride[origName] || origName;
      var initial = displayName.charAt(0).toUpperCase();
      var color = colorOverride[origName] || stringToColor(origName);
      var s = stats[origName] || { total: 0, unsubmitted: 0 };
      var isNew = prefOrder.indexOf(origName) === -1;

      var card = document.createElement("div");
      card.className = "course-card";
      if (_editMode) card.classList.add("editing");
      card.style.setProperty("--course-color", color);
      card.draggable = _editMode;

      var teacher = course.courseTeacher || "";

      // Edit mode structure: drag handle + avatar (clickable for color) + body + color button
      var dragHandleHtml = '<span class="course-drag-handle">⠿</span>';

      var avatarHtml = _editMode
        ? '<span class="course-avatar editable" data-course="' + escapeHtml(origName) + '">' + escapeHtml(initial) + "</span>"
        : '<span class="course-avatar">' + escapeHtml(initial) + "</span>";

      var newBadgeHtml = isNew ? '<span class="course-new-badge">未排序</span>' : "";

      var nameHtml = _editMode
        ? '<p class="course-name"><span class="course-name-editable" data-course="' + escapeHtml(origName) + '">' + escapeHtml(displayName) + "</span>" + newBadgeHtml + "</p>"
        : '<p class="course-name">' + escapeHtml(displayName) + newBadgeHtml + "</p>";

      card.innerHTML =
        dragHandleHtml +
        '<div class="course-card-left">' +
          avatarHtml +
        "</div>" +
        '<div class="course-card-body">' +
          nameHtml +
          '<p class="course-id">' + escapeHtml(course.id || "") + (teacher ? ' · ' + escapeHtml(teacher) : "") + "</p>" +
          '<div class="course-stats">' +
            '<span class="course-stat">作业 ' + s.total + '</span>' +
            (s.unsubmitted > 0 ? '<span class="course-stat course-stat-pending">未交 ' + s.unsubmitted + '</span>' : '<span class="course-stat course-stat-done">已交齐</span>') +
          "</div>" +
        "</div>";

      if (!_editMode) {
        card.style.cursor = "pointer";
        card.addEventListener("click", function () {
          showCourseDetail(origName, card);
        });
      }

      if (_editMode) {
        // Drag events
        card.addEventListener("dragstart", function (e) {
          _dragSrcIndex = i;
          card.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", origName);
        });
        card.addEventListener("dragend", function () {
          card.classList.remove("dragging");
          document.querySelectorAll(".course-card.drag-over").forEach(function (el) {
            el.classList.remove("drag-over");
          });
          stopDragAutoScroll();
        });
        card.addEventListener("dragover", function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          card.classList.add("drag-over");
        });
        card.addEventListener("dragleave", function () {
          card.classList.remove("drag-over");
        });
        card.addEventListener("drop", function (e) {
          e.preventDefault();
          card.classList.remove("drag-over");
          var fromIdx = _dragSrcIndex;
          if (fromIdx === -1 || fromIdx === i) return;
          // Reorder the sorted array
          var item = sorted.splice(fromIdx, 1)[0];
          // After removal, insert position shifts when dragging downward
          var insertIdx = fromIdx < i ? i - 1 : i;
          sorted.splice(insertIdx, 0, item);
          // Save the new order
          var newOrder = sorted.map(function (c) { return c.siteName || ""; }).filter(Boolean);
          _coursePrefs.order = newOrder;
          saveCoursePrefs();
          // Re-render
          renderCourses(courses);
        });

        // Color picker on avatar click
        card.querySelector(".course-avatar.editable")?.addEventListener("click", function (e) {
          e.stopPropagation();
          showColorPicker(this, origName);
        });

        // Name editing on click
        card.querySelector(".course-name-editable")?.addEventListener("click", function (e) {
          e.stopPropagation();
          startNameEdit(this, origName);
        });
      }

      if (window._staggerCourses) {
        card.style.animation = "fadeSlideUp 0.3s ease-out both";
        card.style.animationDelay = (i * 40) + "ms";
      }
      frag.appendChild(card);
    });
    window._staggerCourses = false;

    coursesList.innerHTML = "";
    coursesList.appendChild(frag);
  }


  // ===== Color Picker Modal =====
  var cpOverlay = document.getElementById("color-picker-overlay");
  var cpPreview = document.getElementById("cp-preview");
  var cpCurrentColor = "";
  var cpCourseName = "";
  var cpPresetGrid = document.getElementById("cp-preset-grid");
  var cpRecentGrid = document.getElementById("cp-recent-grid");

  var PRESETS = [
    "hsl(200,55%,55%)","hsl(160,50%,50%)","hsl(280,45%,60%)","hsl(340,55%,60%)","hsl(40,60%,55%)",
    "hsl(100,45%,50%)","hsl(20,60%,60%)","hsl(300,45%,55%)","hsl(180,50%,45%)","hsl(80,50%,50%)",
    "hsl(0,55%,60%)","hsl(220,40%,60%)","hsl(50,55%,50%)","hsl(320,50%,55%)","hsl(140,45%,45%)",
    "hsl(260,50%,50%)","hsl(30,55%,50%)","hsl(190,45%,55%)","hsl(350,50%,55%)","hsl(120,40%,45%)",
  ];

  PRESETS.forEach(function (h) {
    var s = document.createElement("div");
    s.className = "cp-swatch";
    s.style.background = h;
    s.addEventListener("click", function () { selectColor(h); });
    cpPresetGrid.appendChild(s);
  });

  function updatePreview(color) {
    cpPreview.style.background = color;
    cpCurrentColor = color;
    cpPresetGrid.querySelectorAll(".cp-swatch").forEach(function (el) {
      el.classList.toggle("selected", el.style.background === color);
    });
    var m = color.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
    if (m) {
      document.getElementById("cp-h").value = document.getElementById("cp-h-num").value = m[1];
      document.getElementById("cp-s").value = document.getElementById("cp-s-num").value = m[2];
      document.getElementById("cp-l").value = document.getElementById("cp-l-num").value = m[3];
      updateRGBFromHSL(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
      document.getElementById("cp-hex").value = hslToHex(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
    }
    updateRecentSwatches();
  }

  function selectColor(color) {
    updatePreview(color);
    if (!_coursePrefs.colors) _coursePrefs.colors = {};
    _coursePrefs.colors[cpCourseName] = color;
    saveCoursePrefs();
    renderCourses(_savedCourses);
    addRecentColor(color);
  }

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { var k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
    return [Math.round(f(0)*255), Math.round(f(8)*255), Math.round(f(4)*255)];
  }

  function updateRGBFromHSL(h, s, l) {
    var rgb = hslToRgb(h, s, l);
    document.getElementById("cp-r").value = document.getElementById("cp-r-num").value = rgb[0];
    document.getElementById("cp-g").value = document.getElementById("cp-g-num").value = rgb[1];
    document.getElementById("cp-b").value = document.getElementById("cp-b-num").value = rgb[2];
  }

  function hslToHex(h, s, l) {
    var rgb = hslToRgb(h, s, l);
    return rgb.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
  }

  function syncRGB() {
    var r = +document.getElementById("cp-r").value;
    var g = +document.getElementById("cp-g").value;
    var b = +document.getElementById("cp-b").value;
    document.getElementById("cp-r-num").value = r;
    document.getElementById("cp-g-num").value = g;
    document.getElementById("cp-b-num").value = b;
    var nr = r/255, ng = g/255, nb = b/255;
    var max = Math.max(nr,ng,nb), min = Math.min(nr,ng,nb);
    var l = (max+min)/2, s = 0, h = 0;
    if (max !== min) {
      s = l > 0.5 ? (max-min)/(2-max-min) : (max-min)/(max+min);
      h = max === nr ? (ng-nb)/(max-min)+(ng<nb?6:0) : max === ng ? (nb-nr)/(max-min)+2 : (nr-ng)/(max-min)+4;
      h *= 60;
    }
    document.getElementById("cp-h").value = document.getElementById("cp-h-num").value = Math.round(h);
    document.getElementById("cp-s").value = document.getElementById("cp-s-num").value = Math.round(s*100);
    document.getElementById("cp-l").value = document.getElementById("cp-l-num").value = Math.round(l*100);
    var color = "hsl("+Math.round(h)+","+Math.round(s*100)+"%,"+Math.round(l*100)+"%)";
    cpPreview.style.background = color;
    cpCurrentColor = color;
    document.getElementById("cp-hex").value = hslToHex(Math.round(h), Math.round(s*100), Math.round(l*100));
  }

  function syncHSL() {
    var h = +document.getElementById("cp-h").value;
    var s = +document.getElementById("cp-s").value;
    var l = +document.getElementById("cp-l").value;
    document.getElementById("cp-h-num").value = h;
    document.getElementById("cp-s-num").value = s;
    document.getElementById("cp-l-num").value = l;
    document.getElementById("cp-hex").value = hslToHex(h, s, l);
    var color = "hsl("+h+","+s+"%,"+l+"%)";
    cpPreview.style.background = color;
    cpCurrentColor = color;
    updateRGBFromHSL(h, s, l);
  }

  function syncHEX() {
    var hex = document.getElementById("cp-hex").value.replace("#","").trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;
    var r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    document.getElementById("cp-r").value = document.getElementById("cp-r-num").value = r;
    document.getElementById("cp-g").value = document.getElementById("cp-g-num").value = g;
    document.getElementById("cp-b").value = document.getElementById("cp-b-num").value = b;
    syncRGB();
  }

  var RECENT_COLORS = [];
  function loadRecentColors() {
    try { RECENT_COLORS = JSON.parse(localStorage.getItem("cp_recent") || "[]"); } catch(_) { RECENT_COLORS = []; }
  }
  function addRecentColor(color) {
    RECENT_COLORS = RECENT_COLORS.filter(function (c) { return c !== color; });
    RECENT_COLORS.unshift(color);
    if (RECENT_COLORS.length > 10) RECENT_COLORS.pop();
    try { localStorage.setItem("cp_recent", JSON.stringify(RECENT_COLORS)); } catch(_) {}
  }
  function updateRecentSwatches() {
    cpRecentGrid.innerHTML = "";
    RECENT_COLORS.forEach(function (c) {
      var s = document.createElement("div");
      s.className = "cp-swatch";
      s.style.background = c;
      s.addEventListener("click", function () { selectColor(c); });
      cpRecentGrid.appendChild(s);
    });
  }
  loadRecentColors();

  document.querySelectorAll("#color-picker-overlay .cp-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll("#color-picker-overlay .cp-tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll("#color-picker-overlay .cp-panel").forEach(function (p) { p.style.display = "none"; });
      var panel = document.getElementById("cp-panel-" + name);
      if (panel) panel.style.display = "";
    });
  });

  ["r","g","b"].forEach(function (ch) {
    var range = document.getElementById("cp-"+ch), num = document.getElementById("cp-"+ch+"-num");
    range.addEventListener("input", syncRGB);
    num.addEventListener("change", function () { range.value = num.value; syncRGB(); });
  });
  ["h","s","l"].forEach(function (ch) {
    var range = document.getElementById("cp-"+ch), num = document.getElementById("cp-"+ch+"-num");
    range.addEventListener("input", syncHSL);
    num.addEventListener("change", function () { range.value = num.value; syncHSL(); });
  });
  document.getElementById("cp-hex").addEventListener("input", syncHEX);

  document.getElementById("cp-cancel").addEventListener("click", function () { cpOverlay.style.display = "none"; });
  cpOverlay.addEventListener("click", function (e) { if (e.target === cpOverlay) cpOverlay.style.display = "none"; });
  document.getElementById("cp-close").addEventListener("click", function () { cpOverlay.style.display = "none"; });
  document.getElementById("cp-apply").addEventListener("click", function () {
    if (!_coursePrefs.colors) _coursePrefs.colors = {};
    _coursePrefs.colors[cpCourseName] = cpCurrentColor;
    addRecentColor(cpCurrentColor);
    saveCoursePrefs();
    renderCourses(_savedCourses);
    cpOverlay.style.display = "none";
  });

  function showColorPicker(avatarEl, courseName) {
    cpCourseName = courseName;
    var current = (_coursePrefs.colors && _coursePrefs.colors[courseName]) || "hsl(200,55%,55%)";
    updatePreview(current);
    updateRecentSwatches();
    cpOverlay.style.display = "flex";
  }


  function startNameEdit(nameEl, origName) {
    if (nameEl.querySelector("input")) return;
    var currentName = nameEl.textContent;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "course-name-input";
    input.value = currentName;
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();

    function saveName() {
      var newName = input.value.trim();
      if (newName && newName !== currentName) {
        if (!_coursePrefs.names) _coursePrefs.names = {};
        _coursePrefs.names[origName] = newName;
        saveCoursePrefs();
      }
      // Restore display name
      renderCourses(_savedCourses);
    }

    input.addEventListener("blur", saveName);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { input.blur(); }
      if (e.key === "Escape") {
        nameEl.textContent = currentName;
      }
    });
  }

  function saveCoursePrefs() {
    window.buptHw.saveCoursePrefs(_coursePrefs).then(function () {
      window._globalCourseNameOverrides = _coursePrefs.names || {};
      // Notify tasks tab to refresh display names
      document.dispatchEvent(new CustomEvent("course-prefs-changed"));
    }).catch(function (e) {
      setStatus("保存课程设置失败: " + (e.message || e), true);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    bytes = Number(bytes);
    if (isNaN(bytes) || bytes <= 0) return "";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return (i === 0 ? size : size.toFixed(1)) + " " + units[i];
  }

  function getFileIcon(suffix, name) {
    if (!suffix && name) suffix = name.split(".").pop() || "";
    suffix = suffix.toLowerCase();
    var imgs = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"];
    var docs = ["doc", "docx"];
    var sheets = ["xls", "xlsx", "csv"];
    var slides = ["ppt", "pptx"];
    var zips = ["zip", "rar", "7z", "gz", "tar"];
    var vids = ["mp4", "avi", "mov", "mkv"];
    var auds = ["mp3", "wav", "flac"];

    var path, color;
    if (imgs.includes(suffix)) {
      path = '<rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l5-5 3 3 4-5 4 5"/>';
      color = "#e67e22";
    } else if (suffix === "pdf") {
      path = '<path d="M4 2h8l5 5v11H4z"/><path d="M12 2v5h5"/><path d="M5.5 9v5M5.5 9h2.5a2 2 0 0 1 0 4h-2.5"/>';
      color = "#e74c3c";
    } else if (docs.includes(suffix) || slides.includes(suffix) || sheets.includes(suffix)) {
      path = '<path d="M4 2h8l5 5v11H4z"/><path d="M12 2v5h5"/><path d="M6 11h8M6 14h8"/>';
      color = "#2980b9";
    } else if (zips.includes(suffix)) {
      path = '<path d="M4 2h8l5 5v11H4z"/><path d="M12 2v5h5"/><path d="M7 8v6" stroke-dasharray="1.5 1.5" stroke-linecap="round"/><path d="M6 14.5l1 .5.5-1"/>';
      color = "#3498db";
    } else if (vids.includes(suffix)) {
      path = '<path d="M5 4l11 6-11 6z"/>';
      color = "#9b59b6";
    } else if (auds.includes(suffix)) {
      path = '<path d="M8 4v10"/><path d="M8 4h6v7"/><circle cx="6" cy="14" r="2.5"/><circle cx="12" cy="11" r="2.5"/>';
      color = "#27ae60";
    } else {
      path = '<path d="M4 2h8l5 5v11H4z"/><path d="M12 2v5h5"/>';
      color = "currentColor";
    }
    return '<svg class="ficon" viewBox="0 0 20 20" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }

  function showCourseDetail(courseName, cardEl) {
    // Save current scroll position before switching to detail view
    saveScrollPosition();
    coursesList.closest(".tab-panel").scrollTop = 0;
    // Reduce top spacer for detail view
    var tabInner = courseDetailEl.closest(".tab-inner");
    if (tabInner) tabInner.classList.add("detail-view");

    // Set transform-origin from the card position for expand animation
    if (cardEl) {
      var panelRect = courseDetailEl.closest(".tab-panel").getBoundingClientRect();
      var cardRect = cardEl.getBoundingClientRect();
      var originX = ((cardRect.left + cardRect.width / 2) - panelRect.left) / panelRect.width * 100;
      var originY = ((cardRect.top + cardRect.height / 2) - panelRect.top) / panelRect.height * 100;
      courseDetailEl.style.transformOrigin = originX + "% " + originY + "%";
    } else {
      courseDetailEl.style.transformOrigin = "";
    }

    coursesList.style.display = "none";
    coursesEmpty.style.display = "none";
    var coursesHeader = document.querySelector("#tab-courses .courses-header");
    if (coursesHeader) coursesHeader.style.display = "none";
    var coursesToolbar = document.querySelector("#tab-courses .courses-toolbar");
    if (coursesToolbar) coursesToolbar.style.display = "none";
    var coursesSummary = document.querySelector("#tab-courses .courses-summary");
    if (coursesSummary) coursesSummary.style.display = "none";
    // Use display name from prefs if available
    var displayName = (_coursePrefs.names && _coursePrefs.names[courseName]) || courseName;
    courseDetailName.textContent = displayName;

    // Count unsubmitted/total for this course
    var courseUnsubmitted = 0;
    var courseTotal = 0;
    allCachedItems.forEach(function (it) {
      if ((it.course || "").trim() === courseName) {
        courseTotal++;
        if (!it.submitted) courseUnsubmitted++;
      }
    });
    var countEl = document.getElementById("course-detail-count");
    if (countEl) {
      countEl.textContent = courseTotal > 0 ? courseUnsubmitted + " 未交 / " + courseTotal + " 总计" : "";
    }

    // Show teacher info if available
    var courseDetailMeta = document.getElementById("course-detail-meta");
    var teacher = "";
    _savedCourses.forEach(function (c) {
      if ((c.siteName || "").trim() === courseName && c.courseTeacher) {
        teacher = c.courseTeacher;
      }
    });
    if (courseDetailMeta) {
      var metaText = teacher ? "授课教师：" + teacher : "";
      courseDetailMeta.textContent = metaText;
      courseDetailMeta.style.display = metaText ? "" : "none";
    }

    // Trigger expand animation
    courseDetailEl.classList.remove("shrink");
    courseDetailEl.classList.remove("expand");
    void courseDetailEl.offsetHeight; // force reflow
    courseDetailEl.style.display = "block";
    courseDetailEl.classList.add("expand");

    var items = allCachedItems.filter(function (it) {
      return (it.course || "").trim() === courseName;
    });

    // Find siteId for this course to look up course-level resources
    var siteId = "";
    _savedCourses.forEach(function (c) {
      if ((c.siteName || "").trim() === courseName) {
        siteId = c.id;
      }
    });

    // Use course-level resources from cache (fetched via UClass API), not homework attachments
    var courseResources = [];
    if (siteId && _courseResources[siteId]) {
      courseResources = _courseResources[siteId];
    }

    // Sort by due date
    items.sort(function (a, b) {
      var da = parseDueDate(a.due);
      var db = parseDueDate(b.due);
      if (da && db) return da.getTime() - db.getTime();
      if (da && !db) return -1;
      if (!da && db) return 1;
      return (a.title || "").localeCompare(b.title || "");
    });

    // Build course detail content
    var detailHtml = "";

    // Course resources section
    if (courseResources.length > 0) {
      detailHtml += '<div class="course-resources">';
      detailHtml += '<p class="course-resources-title">&#x1F4C1; 课程文件 <span class="course-resources-count">' + courseResources.length + ' 个</span></p>';
      detailHtml += '<div class="course-resources-list">';
      courseResources.forEach(function (res) {
        var suffix = (res.suffix || res.resourceName.split(".").pop() || "").toLowerCase();
        var icon = getFileIcon(suffix, res.resourceName);
        var sizeText = formatFileSize(res.fileSize);
        detailHtml +=
          '<a href="#resource-dl" class="resource-download course-resource-item" ' +
          'data-resource-id="' + escapeHtml(res.resourceId) + '" ' +
          'data-resource-name="' + escapeHtml(res.resourceName) + '">' +
          '<span class="file-icon">' + icon + '</span>' +
          '<span class="file-info">' +
          '<span class="file-name">' + escapeHtml(res.resourceName) + '</span>' +
          '<span class="file-meta">' +
          (suffix ? '<span class="file-type-badge">' + suffix.toUpperCase() + '</span>' : '') +
          (sizeText ? '<span class="file-size">' + sizeText + '</span>' : '') +
          '</span></span></a>';
      });
      detailHtml += '</div></div>';
    }

    if (!items.length) {
      if (courseResources.length > 0) {
        courseDetailItems.innerHTML = detailHtml;
        setStatus(courseName + " — " + courseResources.length + " 个文件");
        wireCourseResourceDownloads();
      } else {
        courseDetailItems.innerHTML = '<p style="color:var(--muted,#8b9bb4);padding:20px;text-align:center">该课程暂无作业</p>';
        setStatus(courseName + " — 暂无作业");
      }
      return;
    }

    var frag = document.createDocumentFragment();
    // Add resources header as a non-task element if resources exist
    if (courseResources.length > 0) {
      var headerEl = document.createElement("div");
      headerEl.innerHTML = detailHtml;
      frag.appendChild(headerEl.firstElementChild);
    }
    items.forEach(function (it) {
      var card = document.createElement("div");
      card.className = "task-card";
      if (it.submitted) {
        card.classList.add("submitted");
        card.style.setProperty("--task-color", "var(--accent2, #7eb87c)");
      } else if (isOverdue(it.due)) {
        card.style.setProperty("--task-color", "var(--err, #f08080)");
      } else {
        var h = hoursUntil(it.due);
        if (h !== null && h < 24) card.style.setProperty("--task-color", "var(--warn, #e8a045)");
        else if (h !== null && h < 72) card.style.setProperty("--task-color", "#c9a845");
        else card.style.setProperty("--task-color", "var(--accent, #5b9fd4)");
      }

      var label = urgencyLabel(it);
      var dueText = formatDueDisplay(it.due);
      var dueHtml = escapeHtml(dueText);
      if (it.submitted) {
        dueHtml = '<span class="submitted-tag">已提交</span>';
      } else if (label) {
        dueHtml = '<span class="due-label">' + label + "</span>" + dueHtml;
      }

      var dueCls = "";
      if (it.submitted) dueCls = "normal";
      else if (isOverdue(it.due)) dueCls = "overdue";

      card.innerHTML =
        '<div class="task-row" style="padding:12px 16px">' +
          '<div class="task-info">' +
            '<p class="task-title">' + escapeHtml(it.title || "（无标题）") + "</p>" +
          "</div>" +
          '<div class="task-due ' + dueCls + '">' +
            dueHtml +
          "</div>" +
        "</div>";

      card.style.cursor = "pointer";
      card.addEventListener("click", function () {
        // Switch to tasks tab and show detail
        window._fromCourseDetail = true;
        saveScrollPosition();
        switchTab(1);
        // Need a small delay for the tab to render
        setTimeout(function () {
          // Dispatch a custom event that the tasks tab can pick up
          var evt = new CustomEvent("show-task-detail", { detail: it });
          document.dispatchEvent(evt);
        }, 50);
      });

      frag.appendChild(card);
    });

    courseDetailItems.innerHTML = "";
    courseDetailItems.appendChild(frag);
    var statusMsg = courseName + " — " + items.length + " 项作业";
    if (courseResources.length > 0) {
      statusMsg += " · " + courseResources.length + " 个课程文件";
    }
    setStatus(statusMsg);
    wireCourseResourceDownloads();
  }

  function wireCourseResourceDownloads() {
    courseDetailItems.querySelectorAll(".resource-download").forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        var rid = link.getAttribute("data-resource-id");
        var rname = link.getAttribute("data-resource-name") || "";
        var filePath = link.getAttribute("data-file-path");

        if (filePath && window.buptHw.showInFolder) {
          window.buptHw.showInFolder(filePath);
          return;
        }

        if (rid && window.buptHw.downloadResource) {
          var origHtml = link.innerHTML;
          link.classList.add("downloading");
          link.innerHTML = '<span class="download-status">下载中...</span>';
          window.buptHw.downloadResource(rid, rname).then(function (result) {
            link.classList.remove("downloading");
            link.innerHTML = origHtml;
            if (!result.ok) {
              link.classList.add("download-failed");
              setStatus('下载失败: ' + (result.error || "未知错误"), true);
              setTimeout(function () { link.classList.remove("download-failed"); }, 3000);
            } else {
              link.setAttribute("data-file-path", result.filePath);
              link.classList.add("downloaded");
            }
          });
        }
      });
    });
  }

  function hideCourseDetail() {
    courseDetailEl.classList.remove("expand");
    courseDetailEl.classList.add("shrink");
    var tabInner = courseDetailEl.closest(".tab-inner");
    if (tabInner) tabInner.classList.remove("detail-view");
    setTimeout(function () {
      courseDetailEl.style.display = "none";
      courseDetailEl.classList.remove("shrink");
      var coursesHeader = document.querySelector("#tab-courses .courses-header");
      if (coursesHeader) coursesHeader.style.display = "";
      var coursesToolbar = document.querySelector("#tab-courses .courses-toolbar");
      if (coursesToolbar) coursesToolbar.style.display = "";
      var coursesSummary = document.querySelector("#tab-courses .courses-summary");
      if (coursesSummary) coursesSummary.style.display = "";
      coursesList.style.display = "";
      window._staggerCourses = true;
      renderCourses(_savedCourses);
      setStatus("");
      var coursesPanel = coursesList.closest(".tab-panel");
      if (coursesPanel && scrollPositions[2] != null) {
        coursesPanel.scrollTop = scrollPositions[2];
      }
    }, 200);
  }

  courseDetailBack.addEventListener("click", hideCourseDetail);

  function loadCoursePrefs() {
    window.buptHw.getCoursePrefs().then(function (prefs) {
      _coursePrefs = prefs || {};
      window._globalCourseNameOverrides = _coursePrefs.names || {};
    }).catch(function () { _coursePrefs = {}; });
  }

  var _scrollPanel = null;

  var _dragSpeed = 0;

  function startDragAutoScroll(e) {
    if (!_editMode) return;
    if (!_scrollPanel) _scrollPanel = coursesList.closest(".tab-panel");
    if (!_scrollPanel) return;
    var rect = _scrollPanel.getBoundingClientRect();
    var y = e.clientY;
    var threshold = 160;
    var maxSpeed = 40;
    if (y - rect.top < threshold) {
      _dragSpeed = -maxSpeed * (1 - (y - rect.top) / threshold);
    } else if (rect.bottom - y < threshold) {
      _dragSpeed = maxSpeed * (1 - (rect.bottom - y) / threshold);
    } else {
      _dragSpeed = 0;
    }
    if (_dragSpeed !== 0 && !_dragScrollTimer) {
      _dragScrollTimer = setInterval(function () {
        _scrollPanel.scrollTop += _dragSpeed;
      }, 16);
    } else if (_dragSpeed === 0 && _dragScrollTimer) {
      clearInterval(_dragScrollTimer);
      _dragScrollTimer = null;
    }
  }

  function stopDragAutoScroll() {
    if (_dragScrollTimer) {
      clearInterval(_dragScrollTimer);
      _dragScrollTimer = null;
    }
  }

  // Listen on document so title bar area is included
  document.addEventListener("dragover", function (e) {
    startDragAutoScroll(e);
  });
  document.addEventListener("dragend", function () {
    stopDragAutoScroll();
  });

  function toggleEditMode() {
    _editMode = !_editMode;
    var btn = document.getElementById("btn-course-edit");
    if (btn) btn.classList.toggle("active", _editMode);
    if (!_editMode) stopDragAutoScroll();
    renderCourses(_savedCourses);
    setStatus(_editMode ? "编辑模式：拖拽排序、点击头像换色、点击名称改名" : "");
  }

  // Wire up edit button
  var btnSyncCourses = document.getElementById("btn-sync-courses");
  if (btnSyncCourses) {
    btnSyncCourses.addEventListener("click", function () {
      btnSyncCourses.disabled = true;
      btnSyncCourses.classList.add("syncing");
      setStatus("正在同步课程...");
      window.buptHw.runFetchCourses().then(function (res) {
        loadCoursesCache();
        if (res.ok) setStatus("课程同步完成");
        else setStatus("同步失败", true);
      }).catch(function (e) {
        setStatus("同步异常：" + (e.message || e), true);
      }).then(function () {
        btnSyncCourses.disabled = false;
        btnSyncCourses.classList.remove("syncing");
      });
    });
  }

  var btnEdit = document.getElementById("btn-course-edit");
  if (btnEdit) {
    btnEdit.addEventListener("click", toggleEditMode);
  }

  var coursesUpdated = document.getElementById("courses-updated");

  function loadCoursesCache() {
    Promise.all([
      window.buptHw.getCache(),
      window.buptHw.getCourseCache(),
      window.buptHw.getCoursePrefs()
    ]).then(function (results) {
      var hwData = results[0];
      var crData = results[1];
      var prefs = results[2];
      _coursePrefs = prefs || {};
      allCachedItems = hwData.items || [];
      _courseResources = (crData && crData.courseResources) || {};
      var courses = (crData && crData.courses) || [];
      renderCourses(courses);
      if (coursesUpdated) {
        coursesUpdated.textContent = (crData && crData.updated_at) ? "上次同步：" + crData.updated_at : "";
      }
      if (courses.length > 0) setStatus("");
      else setStatus("暂无课程数据，请先同步（点击 ↻）");
    }).catch(function (e) {
      setStatus("读取失败：" + (e.message || e), true);
      renderCourses([]);
    });
  }

  if (window.buptHw.onCacheUpdated) {
    window.buptHw.onCacheUpdated(loadCoursesCache);
  }

  loadCoursesCache();
}

