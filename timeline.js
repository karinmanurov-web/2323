(() => {
    "use strict";

    const container = document.getElementById("fox-container");
    if (!container) {
        console.error("Timeline: #fox-container not found.");
        return;
    }

    const $ = (selector, root = document) => root.querySelector(selector);
    const VALID = {
        arms: ["default", "down", "point_left", "wave"],
        brows: ["default", "high", "low"],
        mouth: ["neutral", "open", "surprised", "talk"],
        eyes: ["open", "closed"],
        head: ["none", "nod", "shake", "tilt_left", "tilt_right"],
        position: ["top", "upper_left", "bottom"],
        type: ["none", "word", "transcription", "translation",
            "example", "example_translation", "hook", "cta"],
        size: ["xl", "l", "m"]
    };

    const DEFAULT_POSE = {
        arms: "default",
        brows: "default",
        mouth: "neutral",
        eyes: "open",
        head: "none"
    };

    const params = new URLSearchParams(location.search);
    let bg = ["scene", "green", "transparent"].includes(params.get("bg"))
        ? params.get("bg") : "scene";
    let subtitles = params.get("subs") === "1";
    let duration = 20;
    let beats = [];
    let running = false;
    let time = 0;
    let anchor = 0;
    let raf = 0;
    let lastTime = -1;
    let lastArms = null;
    let lastHeadBeat = -1;
    let headAnimation = null;
    let popAnimation = null;
    let audio = null;
    let audioContext = null;
    let analyser = null;
    let audioData = null;
    let audioURL = null;
    let audioEnabled = false;
    let audioOffset = 0;
    let audioStartContextTime = 0;
    let panelHidden = false;
    let currentCardKey = "";
    let previousCard = null;
    let activeStoryboard = null;
    let manualMouthSpeed = 1;

    container.classList.add("timeline-active");
    container.classList.remove("talking");
    container.dataset.arms = "default";
    container.dataset.brows = "default";
    container.dataset.mouth = "neutral";
    container.dataset.eyes = "open";
    container.dataset.bg = bg;
    document.body.dataset.bg = bg;

    const talkButton = $("#btn-talk");
    if (talkButton) {
        talkButton.addEventListener("click", event => {
            event.stopImmediatePropagation();
            event.preventDefault();
            status("Use the timeline's Play button to animate speech.");
        }, true);
    }

    const cards = document.createElement("div");
    cards.id = "timeline-cards";
    container.appendChild(cards);

    const subtitle = document.createElement("div");
    subtitle.id = "timeline-subtitle";
    subtitle.hidden = true;
    container.appendChild(subtitle);

    const panel = document.createElement("div");
    panel.id = "timeline-panel";
    panel.innerHTML = `
        <div class="timeline-row">
            <button id="tl-play">▶ Play</button>
            <button id="tl-pause">⏸ Pause</button>
            <button id="tl-restart">↺ Restart</button>
            <label>Seek <input id="tl-seek" type="range" min="0" max="20"
                step="0.01" value="0"></label>
            <span id="tl-clock">00.00 / 20.00</span>
            <label>Background
                <select id="tl-bg">
                    <option value="scene">Scene</option>
                    <option value="green">Green</option>
                    <option value="transparent">Transparent</option>
                </select>
            </label>
            <label><input id="tl-subs" type="checkbox"> Subtitles</label>
        </div>
        <div class="timeline-row">
            <label>Storyboard JSON <input id="tl-file" type="file"
                accept=".json,application/json"></label>
            <label>Voice-over audio <input id="tl-audio" type="file"
                accept="audio/*"></label>
            <label>Audio lip-sync <input id="tl-lipsync" type="checkbox" checked></label>
            <label>Mouth speed <input id="tl-speed" type="range"
                min="0.5" max="2" step="0.1" value="1"></label>
            <button id="tl-load">Load pasted JSON</button>
        </div>
        <div class="timeline-row">
            <textarea id="tl-paste" aria-label="Paste storyboard JSON"
                placeholder="Paste storyboard JSON here…"></textarea>
        </div>
        <div id="timeline-status" role="status" aria-live="polite"></div>`;
    document.body.appendChild(panel);

    const togglePanel = document.createElement("button");
    togglePanel.id = "timeline-toggle";
    togglePanel.textContent = "Show controls (H)";
    togglePanel.addEventListener("click", () => {
        panelHidden = false;
        document.body.classList.remove("timeline-panel-hidden");
    });
    document.body.appendChild(togglePanel);

    const el = id => document.getElementById(id);
    const status = (message, error = false) => {
        const node = el("timeline-status");
        if (node) {
            node.textContent = message;
            node.style.whiteSpace = "pre-wrap";
            node.dataset.error = String(error);
        }
    };

    // ---- Lenient parsing: fix what we can, warn about it, skip what we can't ----
    const ALIASES = {
        arms: {
            idle: "default", neutral: "default", rest: "default", normal: "default",
            point: "point_left", pointing: "point_left",
            hello: "wave", hi: "wave", waving: "wave",
            arms_down: "down", lowered: "down"
        },
        brows: {
            neutral: "default", normal: "default",
            raised: "high", up: "high", surprised: "high",
            lowered: "low", down: "low", angry: "low", frown: "low"
        },
        mouth: {
            closed: "neutral", close: "neutral", shut: "neutral", smile: "neutral",
            speak: "talk", speaking: "talk", talking: "talk", say: "talk",
            wide: "open", ooh: "surprised", shocked: "surprised"
        },
        eyes: { close: "closed", shut: "closed", blink: "closed", opened: "open" },
        head: {
            nod_down: "nod", yes: "nod", no: "shake",
            tilt: "tilt_left", left: "tilt_left", right: "tilt_right",
            still: "none", default: "none", neutral: "none"
        },
        position: {
            center: "top", centre: "top", middle: "top", top_center: "top",
            left: "upper_left", top_left: "upper_left",
            bottom_center: "bottom", lower: "bottom"
        },
        type: {
            title: "hook", heading: "hook", foreign: "word", phrase: "word",
            sub: "translation", subtitle: "translation", meaning: "translation",
            pronunciation: "transcription", ipa: "transcription", call_to_action: "cta"
        },
        size: {
            s: "m", small: "m", medium: "m", big: "l", large: "l",
            xlarge: "xl", xxl: "xl", huge: "xl"
        }
    };

    const issues = [];
    let parseNote = "";
    const warn = message => issues.push(message);

    function coerceEnum(key, value, fallback, where) {
        if (value == null || value === "") return fallback;
        const norm = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (VALID[key].includes(norm)) return norm;
        const alias = ALIASES[key] && ALIASES[key][norm];
        if (alias) {
            warn(`${where}: ${key} "${value}" → "${alias}".`);
            return alias;
        }
        warn(`${where}: unknown ${key} "${value}", using "${fallback}". ` +
            `Allowed: ${VALID[key].join(", ")}.`);
        return fallback;
    }

    // Accepts 2.5, "2.5", "2,5", "2.5s", "0:02", "0:02.5", "00:00:02".
    function parseTime(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
        if (typeof value !== "string") return NaN;
        const s = value.trim().replace(",", ".").replace(/s$/i, "");
        if (!s) return NaN;
        if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
        const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
        if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        return NaN;
    }

    // Accepts "t": [a, b] | "a-b" | {start, end} | "start"/"end" | "from"/"to".
    function readRange(raw) {
        let a;
        let b;
        if (Array.isArray(raw.t)) {
            if (raw.t.length === 2) [a, b] = raw.t;
        } else if (typeof raw.t === "string") {
            const parts = raw.t.split(/\s*(?:-|–|—|→|->|\bto\b)\s*/);
            if (parts.length === 2) [a, b] = parts;
        } else if (raw.t && typeof raw.t === "object") {
            a = raw.t.start;
            b = raw.t.end;
        } else {
            a = raw.start ?? raw.from;
            b = raw.end ?? raw.to;
        }
        return [parseTime(a), parseTime(b)];
    }

    function normalizeCard(card, where) {
        if (card == null || card === false) return { type: "none" };
        if (typeof card === "string" || typeof card === "number") {
            return { text: String(card) };
        }
        if (typeof card !== "object" || Array.isArray(card)) {
            warn(`${where}: card must be an object or null, card ignored.`);
            return { type: "none" };
        }
        const n = { ...card };
        const w = `${where} card`;
        if (n.subtitle != null && n.sub == null) n.sub = n.subtitle;
        if (n.position != null) n.position = coerceEnum("position", n.position, "top", w);
        if (n.type != null) n.type = coerceEnum("type", n.type, "hook", w);
        if (n.size != null) n.size = coerceEnum("size", n.size, "m", w);
        if (n.keep != null && typeof n.keep !== "boolean") {
            const k = String(n.keep).trim().toLowerCase();
            n.keep = k === "true" || k === "1" || k === "yes";
            warn(`${w}: keep should be true/false, read as ${n.keep}.`);
        }
        for (const key of ["text", "sub"]) {
            if (n[key] == null || typeof n[key] === "string") continue;
            if (typeof n[key] === "object") {
                warn(`${w}: ${key} must be a string, removed.`);
                delete n[key];
            } else {
                n[key] = String(n[key]);
            }
        }
        if (n.lines != null) {
            if (!Array.isArray(n.lines)) {
                warn(`${w}: lines must be an array, removed.`);
                delete n.lines;
            } else {
                n.lines = n.lines
                    .filter(line => line != null)
                    .map(line => typeof line === "object"
                        ? { ...line, role: line.role == null ? "hook"
                            : coerceEnum("type", line.role, "hook", `${w} line`) }
                        : { role: "hook", text: String(line) });
            }
        }
        return n;
    }

    function normalizePose(raw, where) {
        const src = raw && typeof raw === "object" ? raw : {};
        const pose = {};
        for (const key of ["arms", "brows", "mouth", "eyes", "head"]) {
            pose[key] = coerceEnum(key, src[key], DEFAULT_POSE[key], where);
        }
        return pose;
    }

    function normalizeBeat(raw, index, sourceKey) {
        const where = `${sourceKey}[${index + 1}]`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            warn(`${where}: not an object, beat skipped.`);
            return null;
        }
        let [start, end] = readRange(raw);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            warn(`${where}: can't read the time (use "t": [start, end] in seconds), beat skipped.`);
            return null;
        }
        if (start < 0) {
            warn(`${where}: negative start, set to 0.`);
            start = 0;
        }
        if (end <= start) {
            warn(`${where}: end ≤ start, end set to start + 1s.`);
            end = start + 1;
        }

        let speech = raw.say ?? raw.speech ?? "";
        if (typeof speech !== "string") {
            if (typeof speech === "number") {
                speech = String(speech);
            } else {
                warn(`${where}: say must be a string, set to empty.`);
                speech = "";
            }
        }

        const {
            t, say, speech: _sp, start: _s, end: _e, from: _f, to: _to, pose, card,
            arms, brows, mouth, eyes, head,
            ...rest
        } = raw;

        // Accept both storyboard formats: nested pose objects and flat prompt fields.
        const flat = { arms, brows, mouth, eyes, head };
        let poseInput;
        if (typeof pose === "string") {
            poseInput = { ...flat, arms: pose };
        } else if (pose && typeof pose === "object" && !Array.isArray(pose)) {
            poseInput = { ...flat, ...pose };
        } else {
            if (pose != null) warn(`${where}: pose must be a string or object, ignored.`);
            poseInput = flat;
        }

        return {
            ...rest,
            start,
            end,
            speech,
            pose: normalizePose(poseInput, where),
            card: normalizeCard(card, where)
        };
    }

    const BEAT_KEYS = ["storyboard", "beats", "scenes", "timeline", "script", "segments", "steps"];

    function validate(data) {
        issues.length = 0;
        if (Array.isArray(data)) data = { beats: data };
        if (!data || typeof data !== "object") {
            throw new Error("Expected a JSON object.");
        }
        const sourceKey = BEAT_KEYS.find(k => Array.isArray(data[k]) && data[k].length);
        if (!sourceKey) {
            throw new Error(`Expected a non-empty array under one of: ${BEAT_KEYS.join(", ")}.`);
        }
        if (sourceKey !== "storyboard" && sourceKey !== "beats") {
            warn(`Using "${sourceKey}" as the beats array (expected "beats").`);
        }

        const checked = data[sourceKey]
            .map((beat, index) => normalizeBeat(beat, index, sourceKey))
            .filter(Boolean);
        if (!checked.length) {
            throw new Error(issues.length
                ? `No usable beats:\n${issues.join("\n")}`
                : "No usable beats.");
        }
        checked.sort((a, b) => a.start - b.start);

        const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
        const declared = parseTime(meta.duration_sec ?? meta.duration);
        const end = Math.max(...checked.map(b => b.end));
        let duration = end;
        if (declared > 0) {
            if (declared < end) {
                warn(`meta.duration_sec (${declared}) is shorter than the last beat (${end}), using ${end}.`);
            } else {
                duration = declared;
            }
        }
        return { meta, beats: checked, duration, warnings: [...issues] };
    }

    function describeJSONError(error, text) {
        const m = /position (\d+)/.exec(error.message);
        if (!m) return `Invalid JSON: ${error.message}`;
        const pos = Number(m[1]);
        const before = text.slice(0, pos);
        const line = before.split("\n").length;
        const col = pos - before.lastIndexOf("\n");
        return `Invalid JSON at line ${line}, column ${col}: ` +
            `${error.message.replace(/ in JSON at position.*/, "")}.`;
    }

    // Parses JSON pasted from a chat: strips ``` fences and BOM, text around the JSON,
    // trailing commas and curly quotes. Reports what it repaired via parseNote.
    function parseJSONLoose(text) {
        parseNote = "";
        let s = String(text).replace(/^﻿/, "").trim();
        if (!s) throw new Error("JSON is empty.");
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) s = fence[1].trim();

        const attempts = [s];
        const a = s.search(/[{[]/);
        const b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
        if (a >= 0 && b > a) {
            const core = s.slice(a, b + 1);
            const noCommas = core.replace(/,\s*([}\]])/g, "$1");
            attempts.push(core, noCommas, noCommas.replace(/[“”]/g, '"'));
        }
        let firstError = null;
        for (const candidate of attempts) {
            try {
                const result = JSON.parse(candidate);
                if (candidate !== String(text).trim()) {
                    parseNote = "JSON was auto-repaired (code fence, extra text, trailing comma or curly quotes).";
                }
                return result;
            } catch (error) {
                firstError = firstError || error;
            }
        }
        throw new Error(describeJSONError(firstError, s));
    }

    function readInitialStoryboard() {
        const node = $("#storyboard", document);
        if (!node) {
            status("Add <script type=\"application/json\" id=\"storyboard\"> with your JSON.", true);
            return;
        }
        try {
            loadData(parseJSONLoose(node.textContent));
        } catch (error) {
            status(`Storyboard JSON error: ${error.message}`, true);
        }
    }

    function loadData(data) {
        const note = parseNote;
        const result = validate(data);
        const warnings = note ? [note, ...result.warnings] : result.warnings;
        activeStoryboard = data;
        beats = result.beats;
        duration = result.duration;
        time = 0;
        el("tl-seek").max = String(duration);
        el("tl-seek").value = "0";
        el("tl-clock").textContent = `00.00 / ${duration.toFixed(2)}`;
        currentCardKey = "";
        previousCard = null;
        cards.replaceChildren();
        subtitle.textContent = "";
        lastTime = -1;
        lastArms = null;
        lastHeadBeat = -1;
        applyState(0, true);

        const summary = `Loaded ${beats.length} beats · ${Number(duration.toFixed(2))}s`;
        if (!warnings.length) {
            status(summary);
            return;
        }
        console.warn("Storyboard warnings:\n" + warnings.join("\n"));
        const shown = warnings.slice(0, 6).map(w => `• ${w}`).join("\n");
        const more = warnings.length > 6
            ? `\n… and ${warnings.length - 6} more (see console)` : "";
        status(`${summary} · ⚠ ${warnings.length} warning(s):\n${shown}${more}`);
    }

    function currentBeat(t) {
        for (let i = beats.length - 1; i >= 0; i--) {
            if (t >= beats[i].start && t < beats[i].end) return i;
        }
        return -1;
    }

    function setPose(beat, t, index) {
        const pose = beat ? beat.pose : { ...DEFAULT_POSE };
        container.dataset.arms = pose.arms;
        container.dataset.brows = pose.brows;
        container.dataset.eyes = pose.eyes;

        if (pose.mouth !== "talk") {
            container.dataset.mouth = pose.mouth;
        } else {
            const elapsed = t - beat.start;
            const remaining = beat.end - t;
            
            // Если это конец фразы или текст пустой, рот закрыт
            if (remaining <= 0.15 || !beat.speech || !beat.speech.trim()) {
                container.dataset.mouth = "neutral";
            } else if (audioEnabled && analyser && el("tl-lipsync").checked) {
                // Логика липсинка
                analyser.getByteTimeDomainData(audioData);
                let sum = 0;
                for (let i = 0; i < audioData.length; i++) {
                    const v = (audioData[i] - 128) / 128;
                    sum += v * v;
                }
                const rms = Math.sqrt(sum / audioData.length);
                container.dataset.mouth = rms > 0.035 ? "open" : "neutral";
            } else {
                // Синусоидальное открытие рта (чтобы он точно двигался)
                // 6 раз в секунду рот открывается и закрывается
                const phase = Math.sin(elapsed * 6 * Math.PI);
                container.dataset.mouth = phase > 0 ? "open" : "neutral";
            }
        }

        if (pose.arms !== lastArms && lastArms !== null) {
            const body = $("#mascot_body", container);
            if (body && body.animate) {
                if (popAnimation) popAnimation.cancel();
                popAnimation = body.animate([
                    { scale: "1" }, { scale: "1.02" }, { scale: "1" }
                ], { duration: 200, easing: "ease-out" });
            }
        }
        lastArms = pose.arms;

        if (index !== lastHeadBeat) {
            lastHeadBeat = index;
            animateHead(pose.head);
        }
    }

    function animateHead(kind) {
        const head = $("#mascot_head", container);
        if (!head || !head.animate) return;
        if (headAnimation) headAnimation.cancel();
        headAnimation = null;
        head.style.rotate = "0deg";
        head.style.translate = "0 0";
        head.style.scale = "1";
        if (kind === "none") return;

        const keyframes = {
            nod: [
                { rotate: "0deg" }, { rotate: "5deg", offset: .35 },
                { rotate: "-1.5deg", offset: .7 }, { rotate: "0deg" }
            ],
            shake: [
                { rotate: "0deg" }, { rotate: "-5deg", offset: .25 },
                { rotate: "5deg", offset: .55 }, { rotate: "0deg" }
            ],
            tilt_left: [
                { rotate: "0deg" }, { rotate: "-4deg", offset: .4 },
                { rotate: "-4deg", offset: .7 }, { rotate: "0deg" }
            ],
            tilt_right: [
                { rotate: "0deg" }, { rotate: "4deg", offset: .4 },
                { rotate: "4deg", offset: .7 }, { rotate: "0deg" }
            ]
        };
        headAnimation = head.animate(keyframes[kind], {
            duration: kind.startsWith("tilt") ? 600 : 420,
            easing: "ease-in-out",
            fill: "none"
        });
    }

    function cardMarkup(text) {
        const node = document.createElement("div");
        node.textContent = text;
        return node;
    }

    function updateCard(beat, index) {
        if (!beat) {
            cards.replaceChildren();
            currentCardKey = "";
            previousCard = null;
            return;
        }
        const card = beat.card || { type: "none" };
        if (card.keep === true && previousCard) return;

        const key = `${index}:${JSON.stringify(card)}`;
        if (key === currentCardKey) return;
        currentCardKey = key;
        previousCard = card;

        if (card.type === "none" || (!card.text && !card.lines)) {
            cards.replaceChildren();
            return;
        }

        const node = document.createElement("div");
        node.className = "timeline-card";
        node.dataset.position = card.position || "top";
        node.dataset.size = card.size || "m";

        const lines = Array.isArray(card.lines)
            ? card.lines
            : [
                { role: card.type || "hook", text: card.text || "" },
                ...(card.sub ? [{ role: "translation", text: card.sub }] : [])
            ];

        for (const line of lines) {
            const span = document.createElement("span");
            const role = VALID.type.includes(line.role) ? line.role : "hook";
            span.className = `role-${role}`;
            span.textContent = line.text == null ? "" : String(line.text);
            node.appendChild(span);
            if (line !== lines[lines.length - 1]) node.appendChild(document.createElement("br"));
        }

        cards.replaceChildren(node);
        requestAnimationFrame(() => node.classList.add("is-visible"));
    }

    function applyState(t, force = false) {
        time = Math.max(0, Math.min(duration, t));
        const index = currentBeat(time);
        const beat = index >= 0 ? beats[index] : null;
        if (!force && Math.abs(time - lastTime) < 0.005) return;
        lastTime = time;

        setPose(beat, time, index);
        updateCard(beat, index);

        subtitle.textContent = subtitles && beat ? beat.speech : "";
        subtitle.hidden = !subtitles || !beat || !beat.speech;

        el("tl-seek").value = String(time);
        el("tl-clock").textContent =
            `${time.toFixed(2).padStart(5, "0")} / ${duration.toFixed(2)}`;
    }

    function tick(now) {
        if (!running) return;
        const next = (now - anchor) / 1000;
        if (next >= duration) {
            time = duration;
            applyState(time, true);
            pause();
            return;
        }
        applyState(next);
        raf = requestAnimationFrame(tick);
    }

    function play() {
        if (running) return;
        if (!beats.length) return status("Load a valid storyboard first.", true);
        if (time >= duration) time = 0;
        running = true;
        anchor = performance.now() - time * 1000;
        container.classList.add("animating");
        startAudio();
        raf = requestAnimationFrame(tick);
    }

    function pause() {
        running = false;
        cancelAnimationFrame(raf);
        stopAudio();
        applyState(time, true);
    }

    function restart() {
        pause();
        time = 0;
        lastTime = -1;
        lastArms = null;
        lastHeadBeat = -1;
        applyState(0, true);
        play();
    }

    function seek(value) {
        const wasRunning = running;
        pause();
        time = Math.max(0, Math.min(duration, Number(value) || 0));
        lastTime = -1;
        lastHeadBeat = -1;
        applyState(time, true);
        if (wasRunning) play();
    }

    async function loadAudio(file) {
        stopAudio();
        if (audioURL) URL.revokeObjectURL(audioURL);
        audioURL = URL.createObjectURL(file);
        audio = new Audio(audioURL);
        audio.preload = "auto";
        audio.volume = 0;
        audio.muted = true;
        audioEnabled = false;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error("Web Audio API unavailable.");
            audioContext = new AC();
            const source = audioContext.createMediaElementSource(audio);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.45;
            audioData = new Uint8Array(analyser.fftSize);
            source.connect(analyser);
            audioEnabled = true;
            audioOffset = time;
            status("Audio ready. Play to synchronise it with the timeline.");
        } catch (error) {
            audioEnabled = false;
            status(`Audio lip-sync unavailable: ${error.message}`, true);
        }
    }

    async function startAudio() {
        if (!audio || !audioEnabled) return;
        try {
            await audioContext.resume();
            audio.currentTime = Math.max(0, time - audioOffset);
            audioStartContextTime = audioContext.currentTime;
            await audio.play();
        } catch (error) {
            status(`Audio playback failed: ${error.message}`, true);
        }
    }

    function stopAudio() {
        if (!audio) return;
        audio.pause();
    }

    el("tl-play").addEventListener("click", play);
    el("tl-pause").addEventListener("click", pause);
    el("tl-restart").addEventListener("click", restart);
    el("tl-seek").addEventListener("input", e => seek(e.target.value));
    el("tl-bg").value = bg;
    el("tl-bg").addEventListener("change", e => {
        bg = e.target.value;
        container.dataset.bg = bg;
        document.body.dataset.bg = bg;
        document.body.classList.toggle("chroma-key", bg === "green");
        const url = new URL(location.href);
        url.searchParams.set("bg", bg);
        history.replaceState(null, "", url);
    });
    el("tl-subs").checked = subtitles;
    el("tl-subs").addEventListener("change", e => {
        subtitles = e.target.checked;
        const url = new URL(location.href);
        url.searchParams.set("subs", subtitles ? "1" : "0");
        history.replaceState(null, "", url);
        applyState(time, true);
    });
    el("tl-speed").addEventListener("input", e => {
        manualMouthSpeed = Number(e.target.value);
    });
    el("tl-file").addEventListener("change", async e => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            loadData(parseJSONLoose(await file.text()));
        } catch (error) {
            status(`Could not load JSON: ${error.message}`, true);
        }
    });
    el("tl-load").addEventListener("click", () => {
        try {
            loadData(parseJSONLoose(el("tl-paste").value));
        } catch (error) {
            status(`Could not load JSON: ${error.message}`, true);
        }
    });
    el("tl-audio").addEventListener("change", e => {
        const file = e.target.files[0];
        if (file) loadAudio(file);
    });

    const oldStart = $("#btn-start");
    const oldPause = $("#btn-pause");
    if (oldStart) oldStart.addEventListener("click", play);
    if (oldPause) oldPause.addEventListener("click", pause);

    const oldGreen = $("#btn-green");
    if (oldGreen) {
        oldGreen.addEventListener("click", event => {
            event.stopImmediatePropagation();
            event.preventDefault();
            bg = bg === "green" ? "scene" : "green";
            container.dataset.bg = bg;
            document.body.dataset.bg = bg;
            document.body.classList.toggle("chroma-key", bg === "green");
            el("tl-bg").value = bg;
        }, true);
    }

    function hidePanel() {
        panelHidden = !panelHidden;
        document.body.classList.toggle("timeline-panel-hidden", panelHidden);
    }

    document.addEventListener("keydown", event => {
        if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
        const tag = event.target && event.target.tagName;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
            event.target.isContentEditable) {
            if (event.code !== "Escape") return;
        }
        if (event.code === "Space") {
            event.preventDefault();
            running ? pause() : play();
        } else if (event.key.toLowerCase() === "r") {
            event.preventDefault();
            restart();
        } else if (event.key.toLowerCase() === "h") {
            event.preventDefault();
            hidePanel();
        } else if (event.code === "Escape" && panelHidden) {
            panelHidden = false;
            document.body.classList.remove("timeline-panel-hidden");
        }
    });

    if (params.get("clean") === "1") {
        document.body.classList.add("timeline-clean");
        panelHidden = true;
    }
    readInitialStoryboard();
})();
