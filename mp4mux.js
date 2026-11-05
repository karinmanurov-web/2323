/*
 * Minimal MP4 muxer: one H.264 video track (+ optional AAC audio track).
 *
 * Input is what WebCodecs produces:
 *   - video: AVCC samples (length-prefixed NAL units) and the avcC description,
 *   - audio: raw AAC frames and the AudioSpecificConfig.
 * Output is a non-fragmented, "faststart" MP4 (moov before mdat) kept in memory.
 * Video must be constant frame rate and in decode order == presentation order
 * (no B-frames), which is what VideoEncoder gives with latencyMode "realtime".
 *
 * No dependencies and no DOM access, so it also runs in Node for testing.
 */
(function (root) {
    "use strict";

    const VIDEO_TIMESCALE = 90000;
    const MOVIE_TIMESCALE = 1000;
    const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

    function toU8(part) {
        if (part instanceof Uint8Array) return part;
        if (Array.isArray(part)) return Uint8Array.from(part);
        throw new TypeError("Unsupported box payload");
    }

    function concat(parts) {
        const list = parts.map(toU8);
        let total = 0;
        for (const p of list) total += p.length;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const p of list) {
            out.set(p, offset);
            offset += p.length;
        }
        return out;
    }

    const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const u16 = n => [(n >>> 8) & 255, n & 255];
    const fourcc = s => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

    function box(type, ...parts) {
        const body = concat(parts);
        const out = new Uint8Array(8 + body.length);
        new DataView(out.buffer).setUint32(0, out.length);
        out.set(fourcc(type), 4);
        out.set(body, 8);
        return out;
    }

    function fullBox(type, version, flags, ...parts) {
        return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
    }

    // A table of 32-bit big-endian integers.
    function u32Table(values) {
        const out = new Uint8Array(values.length * 4);
        const view = new DataView(out.buffer);
        for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]);
        return out;
    }

    const UNITY_MATRIX = [
        ...u32(0x00010000), ...u32(0), ...u32(0),
        ...u32(0), ...u32(0x00010000), ...u32(0),
        ...u32(0), ...u32(0), ...u32(0x40000000)
    ];

    function mvhd(duration, nextTrackId, now) {
        return fullBox("mvhd", 0, 0,
            u32(now), u32(now), u32(MOVIE_TIMESCALE), u32(duration),
            u32(0x00010000),             // rate 1.0
            u16(0x0100), u16(0),         // volume 1.0, reserved
            u32(0), u32(0),              // reserved
            UNITY_MATRIX,
            new Uint8Array(24),          // pre_defined
            u32(nextTrackId));
    }

    function tkhd(trackId, duration, width, height, isAudio, now) {
        return fullBox("tkhd", 0, 3,     // enabled | in movie
            u32(now), u32(now), u32(trackId), u32(0), u32(duration),
            u32(0), u32(0),              // reserved
            u16(0), u16(0),              // layer, alternate_group
            u16(isAudio ? 0x0100 : 0), u16(0),
            UNITY_MATRIX,
            u32(width << 16), u32(height << 16));
    }

    function mdhd(timescale, duration, now) {
        return fullBox("mdhd", 0, 0,
            u32(now), u32(now), u32(timescale), u32(duration),
            u16(0x55c4), u16(0));        // language "und", pre_defined
    }

    function hdlr(kind, name) {
        return fullBox("hdlr", 0, 0,
            u32(0), fourcc(kind), u32(0), u32(0), u32(0),
            Array.from(name, c => c.charCodeAt(0)), [0]);
    }

    function dinf() {
        return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    }

    function stts(entries) { // [[count, delta], ...]
        const flat = [];
        for (const [count, delta] of entries) flat.push(count, delta);
        return fullBox("stts", 0, 0, u32(entries.length), u32Table(flat));
    }

    function stsz(sizes) {
        return fullBox("stsz", 0, 0, u32(0), u32(sizes.length), u32Table(sizes));
    }

    function stsc(samplesPerChunk) {
        return fullBox("stsc", 0, 0, u32(1), u32(1), u32(samplesPerChunk), u32(1));
    }

    function stco(offset) {
        return fullBox("stco", 0, 0, u32(1), u32(offset));
    }

    function avc1(width, height, avcC) {
        return box("avc1",
            new Uint8Array(6), u16(1),               // reserved, data_reference_index
            u16(0), u16(0), new Uint8Array(12),      // pre_defined, reserved, pre_defined
            u16(width), u16(height),
            u32(0x00480000), u32(0x00480000),        // 72 dpi
            u32(0), u16(1),                          // reserved, frame_count
            new Uint8Array(32),                      // compressorname
            u16(0x0018), u16(0xffff),                // depth, pre_defined
            box("avcC", avcC));
    }

    function esds(asc, avgBitrate) {
        const decSpecific = [0x05, asc.length, ...asc];
        const decConfig = [
            0x04, 13 + decSpecific.length,
            0x40,                                    // MPEG-4 audio
            0x15,                                    // stream type: audio
            0, 0, 0,                                 // buffer size
            ...u32(avgBitrate), ...u32(avgBitrate),  // max / avg bitrate
            ...decSpecific
        ];
        const slConfig = [0x06, 0x01, 0x02];
        const esDescriptor = [
            0x03, 3 + decConfig.length + slConfig.length,
            0x00, 0x02, 0x00,                        // ES_ID, flags
            ...decConfig, ...slConfig
        ];
        return fullBox("esds", 0, 0, esDescriptor);
    }

    function mp4a(channels, sampleRate, asc, avgBitrate) {
        return box("mp4a",
            new Uint8Array(6), u16(1),               // reserved, data_reference_index
            u32(0), u32(0),                          // reserved
            u16(channels), u16(16), u16(0), u16(0),  // channels, sample size, pre_defined, reserved
            u32(sampleRate * 65536),
            esds(asc, avgBitrate));
    }

    function runLengthEncode(values) {
        const out = [];
        for (const v of values) {
            const last = out[out.length - 1];
            if (last && last[1] === v) last[0] += 1;
            else out.push([1, v]);
        }
        return out;
    }

    class Mp4Muxer {
        /**
         * @param {object} options
         * @param {number} options.width
         * @param {number} options.height
         * @param {number} options.fps            integer, must divide 90000 (24, 25, 30, 50, 60, ...)
         * @param {Uint8Array} options.avcC       AVCDecoderConfigurationRecord
         * @param {object} [options.audio]        { sampleRate, channels, asc, bitrate }
         */
        constructor(options) {
            const { width, height, fps, avcC, audio } = options;
            if (VIDEO_TIMESCALE % fps !== 0) throw new Error(`fps ${fps} does not divide ${VIDEO_TIMESCALE}`);
            if (!(avcC instanceof Uint8Array) || !avcC.length) throw new Error("avcC description is required");
            if (audio && !(audio.asc instanceof Uint8Array && audio.asc.length > 0 && audio.asc.length < 120)) {
                throw new Error("AAC AudioSpecificConfig is required");
            }
            this.width = width;
            this.height = height;
            this.frameDuration = VIDEO_TIMESCALE / fps;
            this.avcC = avcC;
            this.audio = audio || null;
            this.video = { samples: [], keyframes: [] };
            this.sound = { samples: [], durations: [] };
        }

        addVideo(data, isKey) {
            if (!this.video.samples.length && !isKey) throw new Error("First video sample must be a keyframe");
            this.video.samples.push(toU8(data));
            if (isKey) this.video.keyframes.push(this.video.samples.length);
        }

        addAudio(data, durationSamples) {
            this.sound.samples.push(toU8(data));
            this.sound.durations.push(durationSamples);
        }

        finalize() {
            const video = this.video;
            if (!video.samples.length) throw new Error("No video samples");
            const now = (Math.floor(Date.now() / 1000) + MAC_EPOCH_OFFSET) >>> 0;

            const videoBytes = video.samples.reduce((n, s) => n + s.length, 0);
            const audioBytes = this.audio ? this.sound.samples.reduce((n, s) => n + s.length, 0) : 0;
            const videoTicks = video.samples.length * this.frameDuration;
            const videoMs = Math.round(videoTicks * MOVIE_TIMESCALE / VIDEO_TIMESCALE);

            const ftyp = box("ftyp", fourcc("isom"), u32(512),
                fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"));

            const buildMoov = (videoOffset, audioOffset) => {
                let movieMs = videoMs;
                const traks = [];

                const videoStbl = box("stbl",
                    fullBox("stsd", 0, 0, u32(1), avc1(this.width, this.height, this.avcC)),
                    stts([[video.samples.length, this.frameDuration]]),
                    fullBox("stss", 0, 0, u32(video.keyframes.length), u32Table(video.keyframes)),
                    stsc(video.samples.length),
                    stsz(video.samples.map(s => s.length)),
                    stco(videoOffset));
                traks.push(box("trak",
                    tkhd(1, videoMs, this.width, this.height, false, now),
                    box("mdia",
                        mdhd(VIDEO_TIMESCALE, videoTicks, now),
                        hdlr("vide", "VideoHandler"),
                        box("minf",
                            fullBox("vmhd", 0, 1, u16(0), new Uint8Array(6)),
                            dinf(), videoStbl))));

                if (this.audio) {
                    const sound = this.sound;
                    const totalSamples = sound.durations.reduce((a, b) => a + b, 0);
                    const audioMs = Math.round(totalSamples * MOVIE_TIMESCALE / this.audio.sampleRate);
                    movieMs = Math.max(movieMs, audioMs);
                    const avgBitrate = this.audio.bitrate || Math.round(audioBytes * 8 * this.audio.sampleRate / Math.max(1, totalSamples));
                    const audioStbl = box("stbl",
                        fullBox("stsd", 0, 0, u32(1),
                            mp4a(this.audio.channels, this.audio.sampleRate, this.audio.asc, avgBitrate)),
                        stts(runLengthEncode(sound.durations)),
                        stsc(sound.samples.length),
                        stsz(sound.samples.map(s => s.length)),
                        stco(audioOffset));
                    traks.push(box("trak",
                        tkhd(2, audioMs, 0, 0, true, now),
                        box("mdia",
                            mdhd(this.audio.sampleRate, totalSamples, now),
                            hdlr("soun", "SoundHandler"),
                            box("minf",
                                fullBox("smhd", 0, 0, u16(0), u16(0)),
                                dinf(), audioStbl))));
                }
                return box("moov", mvhd(movieMs, this.audio ? 3 : 2, now), ...traks);
            };

            const sizeProbe = buildMoov(0, 0).length;
            const dataStart = ftyp.length + sizeProbe + 8;
            const total = dataStart + videoBytes + audioBytes;
            if (total > 0xffffffff) throw new Error("Video is larger than 4 GB, which this muxer does not support.");
            const moov = buildMoov(dataStart, dataStart + videoBytes);
            if (moov.length !== sizeProbe) throw new Error("Internal error: moov size changed");

            const out = new Uint8Array(total);
            let pos = 0;
            out.set(ftyp, pos); pos += ftyp.length;
            out.set(moov, pos); pos += moov.length;
            new DataView(out.buffer).setUint32(pos, 8 + videoBytes + audioBytes);
            out.set(fourcc("mdat"), pos + 4);
            pos += 8;
            for (const s of video.samples) { out.set(s, pos); pos += s.length; }
            if (this.audio) for (const s of this.sound.samples) { out.set(s, pos); pos += s.length; }
            return out;
        }
    }

    root.Mp4Muxer = Mp4Muxer;
    if (typeof module !== "undefined" && module.exports) module.exports = { Mp4Muxer };
})(typeof window !== "undefined" ? window : globalThis);
