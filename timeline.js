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
            node.dataset.error = String(error);
        }
    };

    function normalizeCard(card, index) {
        if (card == null) return { type: "none" };
        if (typeof card !== "object") {
            throw new Error(`Beat ${index + 1}: card must be an object or null.`);
        }
        const normalized = { ...card };
        if (normalized.subtitle != null && normalized.sub == null) {
            normalized.sub = normalized.subtitle;
        }
        if (normalized.position != null && !VALID.position.includes(normalized.position)) {
            throw new Error(`Beat ${index + 1}: invalid card position "${normalized.position}".`);
        }
        if (normalized.type != null && !VALID.type.includes(normalized.type)) {
            throw new Error(`Beat ${index + 1}: invalid card type "${normalized.type}".`);
        }
        if (normalized.size != null && !VALID.size.includes(normalized.size)) {
            throw new Error(`Beat ${index + 1}: invalid card size "${normalized.size}".`);
        }
        if (normalized.keep != null && typeof normalized.keep !== "boolean") {
            throw new Error(`Beat ${index + 1}: card.keep must be boolean.`);
        }
        if (normalized.text != null && typeof normalized.text !== "string") {
            throw new Error(`Beat ${index + 1}: card.text must be a string.`);
        }
        if (normalized.sub != null && typeof normalized.sub !== "string") {
            throw new Error(`Beat ${index + 1}: card.sub must be a string.`);
        }
        return normalized;
    }

    function normalizePose(rawPose, index) {
        if (rawPose == null) return { ...DEFAULT_POSE };
        if (typeof rawPose === "string") {
            if (!VALID.arms.includes(rawPose)) {
                throw new Error(`Beat ${index + 1}: invalid pose string "${rawPose}".`);
            }
            return { ...DEFAULT_POSE, arms: rawPose };
        }
        if (typeof rawPose !== "object") {
            throw new Error(`Beat ${index + 1}: pose must be a string or object.`);
        }
        const pose = { ...DEFAULT_POSE, ...rawPose };
        for (const key of ["arms", "brows", "mouth", "eyes", "head"]) {
            if (!VALID[key].includes(pose[key])) {
                throw new Error(`Beat ${index + 1}: invalid ${key} enum.`);
            }
        }
        return pose;
    }

    function normalizeBeat(raw, index, sourceKey) {
        if (!raw || typeof raw !== "object") {
            throw new Error(`${sourceKey}[${index + 1}]: must be an object.`);
        }
        let start;
        let end;
        if (Array.isArray(raw.t)) {
            if (raw.t.length !== 2 ||
                !raw.t.every(v => typeof v === "number" && Number.isFinite(v))) {
                throw new Error(`${sourceKey}[${index + 1}]: t must be an array of two numbers.`);
            }
            [start, end] = raw.t;
        } else if (Number.isFinite(raw.start) && Number.isFinite(raw.end)) {
            start = raw.start;
            end = raw.end;
        } else {
            throw new Error(`${sourceKey}[${index + 1}]: missing t/start/end.`);
        }
        if (start < 0 || end <= start) {
            throw new Error(`${sourceKey}[${index + 1}]: start/end must be valid increasing times.`);
        }
        const speech = raw.say ?? raw.speech ?? "";
        if (typeof speech !== "string") {
            throw new Error(`${sourceKey}[${index + 1}]: say/speech must be a string.`);
        }

        const {
            t, say, speech: _sp, start: _s, end: _e, pose, card,
            brows: _brows, mouth: _mouth, eyes: _eyes, head: _head,
            ...rest
        } = raw;

        // Accept both storyboard formats: nested pose objects and flat prompt fields.
        const flatPose = {};
        for (const key of ["brows", "mouth", "eyes", "head"]) {
            if (raw[key] != null) flatPose[key] = raw[key];
        }
        const poseInput = typeof pose === "string"
            ? { ...flatPose, arms: pose }
            : { ...flatPose, ...(pose || {}) };

        return {
            ...rest,
            start,
            end,
            speech,
            pose: normalizePose(poseInput, index),
            card: normalizeCard(card, index)
        };
    }

    function validate(data) {
        if (!data || typeof data !== "object") {
            throw new Error("Expected a JSON object.");
        }
        let source = null;
        let sourceKey = null;
        if (Array.isArray(data.storyboard) && data.storyboard.length) {
            source = data.storyboard;
            sourceKey = "storyboard";
        } else if (Array.isArray(data.beats) && data.beats.length) {
            source = data.beats;
            sourceKey = "beats";
        }
        if (!source) {
            throw new Error('Expected a non-empty "storyboard" or "beats" array.');
        }

        const checked = source.map((beat, index) => normalizeBeat(beat, index, sourceKey));
        checked.sort((a, b) => a.start - b.start);
        for (let i = 1; i < checked.length; i++) {
            if (checked[i].start < checked[i - 1].end - 1e-6) {
                // перекрытия допустимы, но зафиксируем порядок
            }
        }

        const meta = data.meta || {};
        const declared = Number(meta.duration_sec);
        const end = Math.max(...checked.map(b => b.end));
        return { meta, beats: checked, duration: declared > 0 ? declared : end };
    }

    function readInitialStoryboard() {
        const node = $("#storyboard", document);
        if (!node) {
            status("Add <script type=\"application/json\" id=\"storyboard\"> with your JSON.", true);
            return;
        }
        try {
            loadData(JSON.parse(node.textContent));
        } catch (error) {
            status(`Storyboard JSON error: ${error.message}`, true);
        }
    }

    function loadData(data) {
        const result = validate(data);
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
        status(`Loaded ${beats.length} beats · ${duration}s`);
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
            loadData(JSON.parse(await file.text()));
        } catch (error) {
            status(`Could not load JSON: ${error.message}`, true);
        }
    });
    el("tl-load").addEventListener("click", () => {
        try {
            loadData(JSON.parse(el("tl-paste").value));
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
