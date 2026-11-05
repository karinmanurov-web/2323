/*
 * "Скачать видео": renders the fox timeline frame by frame (not in real time),
 * encodes it with WebCodecs (H.264, plus AAC for the voice-over) and saves an .mp4.
 *
 * How a frame is made:
 *   1. timeline.js is put into the state for time t (pose, mouth, card, ...).
 *   2. All running animations are frozen at the right moment of their timeline.
 *   3. The stage is copied into a standalone SVG <foreignObject> image. The copy cannot see
 *      the page's CSS, so what matters is baked in: hidden parts are dropped, animated
 *      transforms and the card styles are written as inline computed values.
 *   4. The image is drawn to a canvas at the chosen resolution and sent to the encoder.
 *
 * Needs a Chromium-based browser (Chrome, Edge) for VideoEncoder. Depends on mp4mux.js.
 */
(() => {
    "use strict";

    const api = window.foxTimeline;
    const container = document.getElementById("fox-container");
    const panel = document.getElementById("timeline-panel");
    if (!api || !container || !panel || !window.Mp4Muxer) {
        console.warn("video-export: timeline.js or mp4mux.js is missing; export disabled.");
        return;
    }

    const RENDERABLE = new Set(["g", "path", "circle", "ellipse", "rect", "polygon",
        "polyline", "line", "use", "image", "text", "tspan"]);
    const AVC_LEVELS = [ // [codec string, max macroblocks per frame, max macroblocks per second]
        ["avc1.64001F", 3600, 108000],     // High, level 3.1
        ["avc1.640028", 8192, 245760],     // level 4.0
        ["avc1.64002A", 8704, 522240],     // level 4.2
        ["avc1.640033", 36864, 983040]     // level 5.1
    ];
    const AUDIO_RATE = 48000;
    const AUDIO_CHANNELS = 2;
    const AUDIO_BITRATE = 160000;

    class CancelledError extends Error {}

    // Copies a codec "description" (ArrayBuffer or typed array) into a fresh Uint8Array.
    function toBytes(description) {
        if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
        return new Uint8Array(description.buffer.slice(
            description.byteOffset, description.byteOffset + description.byteLength));
    }

    // ------------------------------------------------------------------ UI

    const row = document.createElement("div");
    row.className = "timeline-row";
    row.id = "export-row";
    row.innerHTML = `
        <label>Видео
            <select id="ex-size" aria-label="Размер видео">
                <option value="1080">1080×1920</option>
                <option value="720">720×1280 (быстрее)</option>
            </select>
        </label>
        <label>Кадров/с
            <select id="ex-fps" aria-label="Кадров в секунду">
                <option value="30">30</option>
                <option value="24">24</option>
                <option value="60">60</option>
            </select>
        </label>
        <label><input id="ex-audio" type="checkbox" checked> Со звуком</label>
        <button id="ex-go" type="button">⬇ Скачать видео</button>
        <button id="ex-cancel" type="button" hidden>✕ Отмена</button>
        <progress id="ex-progress" max="1" value="0" hidden></progress>
        <div id="ex-status" role="status" aria-live="polite"></div>`;
    const anchor = document.getElementById("timeline-status");
    panel.insertBefore(row, anchor);

    const $ = id => document.getElementById(id);
    const goButton = $("ex-go");
    const cancelButton = $("ex-cancel");
    const progress = $("ex-progress");

    function setStatus(message, isError = false) {
        const node = $("ex-status");
        node.textContent = message;
        node.dataset.error = String(isError);
    }

    if (!window.VideoEncoder || !window.VideoFrame) {
        goButton.disabled = true;
        goButton.title = "Нужен браузер на движке Chromium (Chrome, Edge)";
        setStatus("Скачивание видео работает в Chrome или Edge: в этом браузере нет WebCodecs.", true);
    }

    // ------------------------------------------------------- frame rendering

    function cssBackground() {
        const color = getComputedStyle(container).backgroundColor;
        const transparent = !color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
        return transparent ? "#00FF00" : color;
    }

    // Writes every computed style of an element tree inline, so it renders the same without the page CSS.
    function inlineTree(original) {
        const clone = original.cloneNode(true);
        const from = [original, ...original.querySelectorAll("*")];
        const to = [clone, ...clone.querySelectorAll("*")];
        for (let i = 0; i < from.length; i++) {
            const computed = getComputedStyle(from[i]);
            const style = to[i].style;
            style.cssText = "";
            for (const name of computed) {
                if (name.startsWith("animation") || name.startsWith("transition")) continue;
                style.setProperty(name, computed.getPropertyValue(name));
            }
        }
        return clone;
    }

    function createFrameRenderer(outW, outH) {
        const stage = container.getBoundingClientRect();
        const svg = container.querySelector(":scope > svg");
        if (!svg) throw new Error("не найден рисунок лисы (svg)");
        const svgRect = svg.getBoundingClientRect();
        const svgBox = {
            left: svgRect.left - stage.left,
            top: svgRect.top - stage.top,
            width: svgRect.width,
            height: svgRect.height
        };
        const background = cssBackground();

        // The artwork never changes structure, so these are computed once.
        const elements = [svg, ...svg.querySelectorAll("*")];
        const styles = elements.map(el => getComputedStyle(el));
        const subtreeEnd = elements.map((el, i) => i + el.querySelectorAll("*").length);
        const cardsRoot = container.querySelector("#timeline-cards");
        const subtitleRoot = container.querySelector("#timeline-subtitle");

        const canvas = document.createElement("canvas");
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        let bufferPathFailed = false;

        function buildMarkup() {
            const svgClone = svg.cloneNode(true);
            const clones = [svgClone, ...svgClone.querySelectorAll("*")];

            for (let i = 1; i < elements.length; i++) {
                const el = elements[i];
                const cs = styles[i];
                if (!RENDERABLE.has(el.localName)) continue;
                if (cs.display === "none" || cs.opacity === "0") {
                    clones[i].remove();
                    i = subtreeEnd[i];
                    continue;
                }
                const style = clones[i].style;
                if (cs.opacity !== "1") style.setProperty("opacity", cs.opacity);
                if (cs.visibility === "hidden") style.setProperty("visibility", "hidden");
                const transform = cs.transform, translate = cs.translate,
                    rotate = cs.rotate, scale = cs.scale;
                if (transform !== "none" || translate !== "none" || rotate !== "none" || scale !== "none") {
                    if (transform !== "none") style.setProperty("transform", transform);
                    if (translate !== "none") style.setProperty("translate", translate);
                    if (rotate !== "none") style.setProperty("rotate", rotate);
                    if (scale !== "none") style.setProperty("scale", scale);
                    style.setProperty("transform-origin", cs.transformOrigin);
                    style.setProperty("transform-box", cs.transformBox);
                }
            }

            const rootStyle = svgClone.getAttribute("style") || "";
            svgClone.setAttribute("style", `${rootStyle};position:absolute;left:${svgBox.left}px;` +
                `top:${svgBox.top}px;width:${svgBox.width}px;height:${svgBox.height}px;` +
                "max-width:none;max-height:none;display:block;overflow:visible;transform:none");

            const wrapper = document.createElement("div");
            wrapper.setAttribute("style", `position:relative;width:${stage.width}px;` +
                `height:${stage.height}px;overflow:hidden;margin:0;padding:0;background:${background}`);
            wrapper.appendChild(svgClone);
            if (cardsRoot && cardsRoot.childElementCount) wrapper.appendChild(inlineTree(cardsRoot));
            if (subtitleRoot && !subtitleRoot.hidden && subtitleRoot.textContent) {
                wrapper.appendChild(inlineTree(subtitleRoot));
            }
            const html = new XMLSerializer().serializeToString(wrapper);
            return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" ` +
                `viewBox="0 0 ${stage.width} ${stage.height}" preserveAspectRatio="none">` +
                `<foreignObject x="0" y="0" width="${stage.width}" height="${stage.height}">${html}</foreignObject></svg>`;
        }

        async function draw() {
            // A data: URL, not a blob: URL: Chrome marks the canvas as "tainted" for blob URLs of
            // SVG images, and a tainted canvas cannot be passed to the video encoder.
            const image = new Image();
            image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildMarkup());
            await image.decode();
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, outW, outH);
            ctx.drawImage(image, 0, 0, outW, outH);
            return canvas;
        }

        // Standard video colours (BT.709, limited range) are only reachable through a pixel buffer;
        // a VideoFrame made straight from a canvas is tagged full-range sRGB, which some editors
        // and platforms treat less reliably. Falls back to the canvas if the buffer path fails.
        function toVideoFrame(timestamp, duration) {
            if (!bufferPathFailed) {
                try {
                    const pixels = ctx.getImageData(0, 0, outW, outH);
                    return new VideoFrame(pixels.data, {
                        format: "RGBA", codedWidth: outW, codedHeight: outH, timestamp, duration,
                        colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false }
                    });
                } catch (error) {
                    bufferPathFailed = true;
                    console.warn("video-export: RGBA frames unavailable, using canvas frames.", error);
                }
            }
            return new VideoFrame(canvas, { timestamp, duration });
        }

        return { canvas, draw, buildMarkup, toVideoFrame };
    }

    // Puts the stage into the state for time t, with every animation frozen at the right moment.
    function prepareStage(t, level) {
        api.renderFrameState(t, level);

        // A new card fades in via a CSS transition that normally starts a frame later.
        for (const card of container.querySelectorAll("#timeline-cards .timeline-card:not(.is-visible)")) {
            void getComputedStyle(card).opacity;
            card.classList.add("is-visible");
        }

        const beat = api.beatAt(t);
        const beatStart = beat ? beat.start : t;
        for (const animation of container.getAnimations({ subtree: true })) {
            let endless = false;
            try {
                endless = animation.effect.getComputedTiming().iterations === Infinity;
            } catch (_) { /* animation without an effect */ }
            animation.pause();
            // Idle loops (float, blink, ...) follow the global time; one-shot motions
            // (nod, pop, card fade-in) start with their beat.
            animation.currentTime = (endless ? t : Math.max(0, t - beatStart)) * 1000;
        }
    }

    // ----------------------------------------------------------------- audio

    async function prepareAudio(file, duration, offset) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const decodeContext = new AudioCtx();
        let decoded;
        try {
            decoded = await decodeContext.decodeAudioData(await file.arrayBuffer());
        } finally {
            decodeContext.close();
        }
        const length = Math.ceil(duration * AUDIO_RATE);
        const offline = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_RATE);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(Math.max(0, offset || 0));
        return offline.startRendering();
    }

    // Loudness (RMS) of the voice-over in the next frame's time window, for lip-sync.
    function createLevelFunction(rendered, fps) {
        const left = rendered.getChannelData(0);
        const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
        const prefix = new Float64Array(left.length + 1);
        for (let i = 0; i < left.length; i++) {
            const mono = (left[i] + right[i]) / 2;
            prefix[i + 1] = prefix[i] + mono * mono;
        }
        const span = Math.max(1, Math.round(AUDIO_RATE / fps));
        return t => {
            const a = Math.max(0, Math.min(left.length - 1, Math.floor(t * AUDIO_RATE)));
            const b = Math.min(left.length, a + span);
            return Math.sqrt((prefix[b] - prefix[a]) / Math.max(1, b - a));
        };
    }

    async function encodeAudio(rendered, onProgress) {
        const chunks = [];
        let asc = null;
        let sampleRate = AUDIO_RATE;
        let channels = AUDIO_CHANNELS;
        let failure = null;
        const encoder = new AudioEncoder({
            output: (chunk, meta) => {
                const config = meta && meta.decoderConfig;
                if (config && config.description && !asc) {
                    asc = toBytes(config.description);
                    sampleRate = config.sampleRate || sampleRate;
                    channels = config.numberOfChannels || channels;
                }
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                const samples = chunk.duration
                    ? Math.max(1, Math.round(chunk.duration * AUDIO_RATE / 1e6)) : 1024;
                chunks.push({ data, samples });
            },
            error: error => { failure = error; }
        });
        encoder.configure({
            codec: "mp4a.40.2", sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS,
            bitrate: AUDIO_BITRATE, aac: { format: "aac" }
        });

        const total = rendered.length;
        const step = 4096;
        const channelData = [];
        for (let c = 0; c < AUDIO_CHANNELS; c++) {
            channelData.push(rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1)));
        }
        for (let pos = 0; pos < total; pos += step) {
            if (failure) throw failure;
            const length = Math.min(step, total - pos);
            const planar = new Float32Array(length * AUDIO_CHANNELS);
            for (let c = 0; c < AUDIO_CHANNELS; c++) {
                planar.set(channelData[c].subarray(pos, pos + length), c * length);
            }
            const audioData = new AudioData({
                format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: length,
                numberOfChannels: AUDIO_CHANNELS, timestamp: Math.round(pos * 1e6 / AUDIO_RATE),
                data: planar
            });
            encoder.encode(audioData);
            audioData.close();
            while (encoder.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 2));
            onProgress(pos / total);
        }
        await encoder.flush();
        encoder.close();
        if (failure) throw failure;
        if (!asc || !chunks.length) throw new Error("кодировщик звука не вернул данных");
        return { chunks, asc, sampleRate, channels };
    }

    // ----------------------------------------------------------------- video

    async function pickVideoConfig(width, height, fps) {
        const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
        const bitrate = Math.min(40e6, Math.max(2e6, Math.round(width * height * fps * 0.15)));
        for (const [codec, maxFrame, maxRate] of AVC_LEVELS) {
            if (macroblocks > maxFrame || macroblocks * fps > maxRate) continue;
            const config = {
                codec, width, height, bitrate, framerate: fps,
                latencyMode: "realtime",         // no B-frames: decode order equals display order
                avc: { format: "avc" }
            };
            const support = await VideoEncoder.isConfigSupported(config);
            if (support.supported) return config;
        }
        return null;
    }

    // ---------------------------------------------------------------- export

    let busy = false;
    let cancelRequested = false;

    function setLocked(locked) {
        const controls = panel.querySelectorAll("button, input, select, textarea");
        for (const control of controls) {
            if (control === cancelButton) continue;
            if (locked) {
                control.dataset.wasDisabled = control.disabled ? "1" : "";
                control.disabled = true;
            } else {
                control.disabled = control.dataset.wasDisabled === "1";
                delete control.dataset.wasDisabled;
            }
        }
        cancelButton.hidden = !locked;
        progress.hidden = !locked;
    }

    function fileName(width, height) {
        const rubric = String(api.meta.rubric || "").trim().replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
        return `fox_${rubric || "video"}_${width}x${height}.mp4`;
    }

    function download(bytes, name) {
        const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function formatSeconds(seconds) {
        if (!Number.isFinite(seconds)) return "…";
        const s = Math.max(0, Math.round(seconds));
        return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`;
    }

    async function exportVideo() {
        if (busy) return;
        if (!api.beats.length) {
            setStatus("Сначала загрузите сториборд (JSON).", true);
            return;
        }
        busy = true;
        cancelRequested = false;
        const notes = [];
        const width = Number($("ex-size").value);
        const height = Math.round(width * 16 / 9);
        const fps = Number($("ex-fps").value);
        const duration = api.duration;
        const totalFrames = Math.max(1, Math.round(duration * fps));
        let token = null;
        let videoEncoder = null;
        setLocked(true);
        progress.value = 0;

        const checkCancel = () => { if (cancelRequested) throw new CancelledError(); };

        try {
            setStatus("Подготовка…");
            const videoConfig = await pickVideoConfig(width, height, fps);
            if (!videoConfig) throw new Error("этот браузер не умеет кодировать H.264 в таком размере");

            // Audio first: if it fails, we find out before the long render.
            // The voice-over is decoded whenever it is loaded (lip-sync needs it);
            // it is only encoded into the file if "Со звуком" is ticked.
            let audio = null;
            let level = null;
            const wantAudio = $("ex-audio").checked;
            if (api.audioFile) {
                try {
                    setStatus("Обработка озвучки…");
                    const rendered = await prepareAudio(api.audioFile, duration, api.audioOffset);
                    if (api.lipSync) level = createLevelFunction(rendered, fps);
                    if (wantAudio) {
                        const support = window.AudioEncoder
                            ? await AudioEncoder.isConfigSupported({
                                codec: "mp4a.40.2", sampleRate: AUDIO_RATE,
                                numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE
                            }) : { supported: false };
                        if (support.supported) {
                            audio = await encodeAudio(rendered, fraction => {
                                progress.value = fraction * 0.05;
                            });
                        } else {
                            notes.push("браузер не умеет кодировать звук в AAC — видео без звука, озвучку добавьте в видеоредакторе");
                        }
                    }
                } catch (error) {
                    notes.push(`озвучка не обработана (${error.message}) — видео без звука`);
                    audio = null;
                    level = null;
                }
            } else if (wantAudio) {
                notes.push("озвучка не загружена — видео без звука");
            }
            checkCancel();

            if (api.background === "transparent") {
                notes.push("в mp4 нет прозрачности — фон заменён на зелёный");
            }

            token = api.beginExport();
            document.body.classList.add("timeline-exporting");
            void container.offsetWidth;
            const renderer = createFrameRenderer(width, height);

            const videoChunks = [];
            let avcC = null;
            let encoderError = null;
            videoEncoder = new VideoEncoder({
                output: (chunk, meta) => {
                    const config = meta && meta.decoderConfig;
                    if (config && config.description && !avcC) avcC = toBytes(config.description);
                    const data = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(data);
                    videoChunks.push({ data, key: chunk.type === "key" });
                },
                error: error => { encoderError = error; }
            });
            videoEncoder.configure(videoConfig);

            const started = performance.now();
            const keyEvery = fps * 2;
            for (let i = 0; i < totalFrames; i++) {
                checkCancel();
                if (encoderError) throw encoderError;
                const t = i / fps;
                prepareStage(t, level);
                await renderer.draw();
                const frame = renderer.toVideoFrame(Math.round(i * 1e6 / fps), Math.round(1e6 / fps));
                videoEncoder.encode(frame, { keyFrame: i % keyEvery === 0 });
                frame.close();
                while (videoEncoder.encodeQueueSize > 6) {
                    checkCancel();
                    await new Promise(resolve => setTimeout(resolve, 4));
                }
                const done = i + 1;
                progress.value = 0.05 + 0.9 * done / totalFrames;
                if (done % 5 === 0 || done === totalFrames) {
                    const perFrame = (performance.now() - started) / done;
                    setStatus(`Кадр ${done} из ${totalFrames} · осталось ≈ ${formatSeconds(perFrame * (totalFrames - done) / 1000)}`);
                }
            }
            await videoEncoder.flush();
            videoEncoder.close();
            videoEncoder = null;
            if (encoderError) throw encoderError;
            if (videoChunks.length !== totalFrames || !avcC) {
                throw new Error(`кодировщик вернул ${videoChunks.length} кадров из ${totalFrames}`);
            }

            setStatus("Сборка файла…");
            progress.value = 0.97;
            const muxer = new Mp4Muxer({
                width, height, fps, avcC,
                audio: audio && {
                    sampleRate: audio.sampleRate, channels: audio.channels,
                    asc: audio.asc, bitrate: AUDIO_BITRATE
                }
            });
            for (const chunk of videoChunks) muxer.addVideo(chunk.data, chunk.key);
            if (audio) for (const chunk of audio.chunks) muxer.addAudio(chunk.data, chunk.samples);
            const bytes = muxer.finalize();

            const name = fileName(width, height);
            download(bytes, name);
            progress.value = 1;
            const size = (bytes.length / 1048576).toFixed(1);
            const total = `${formatSeconds((performance.now() - started) / 1000)}`;
            setStatus(`Готово: ${name} · ${size} МБ · ${width}×${height}, ${fps} к/с, ${duration.toFixed(1)} с` +
                `${audio ? ", со звуком" : ", без звука"} (рендер ${total})` +
                `${notes.length ? "\n⚠ " + notes.join("\n⚠ ") : ""}`);
        } catch (error) {
            if (error instanceof CancelledError) {
                setStatus("Экспорт отменён.");
            } else {
                console.error("Video export failed:", error);
                setStatus(`Не удалось сделать видео: ${error.message || error}`, true);
            }
        } finally {
            if (videoEncoder) {
                try { videoEncoder.close(); } catch (_) { /* already closed */ }
            }
            document.body.classList.remove("timeline-exporting");
            if (token) api.endExport(token);
            setLocked(false);
            busy = false;
        }
    }

    goButton.addEventListener("click", exportVideo);
    cancelButton.addEventListener("click", () => {
        cancelRequested = true;
        setStatus("Отмена…");
    });

    // Exposed for tests and debugging.
    window.foxVideoExport = { exportVideo, createFrameRenderer, prepareStage, createLevelFunction };
})();
