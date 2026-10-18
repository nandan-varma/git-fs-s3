import { describe, expect, it } from "vitest";
import {
	pktLine,
	pktLineBuffer,
	sideBandPackfile,
} from "../../src/http/pkt-line.js";
import { decodeAscii } from "../../src/index.js";

/** Largest body a four-hex-digit length prefix can describe: 0xffff - 4. */
const MAX_BODY = 0xffff - 4;

describe("pktLine / pktLineBuffer", () => {
	it("frames the largest legal body with an ffff length prefix", () => {
		const framed = pktLineBuffer(new Uint8Array(MAX_BODY));
		expect(framed.length).toBe(MAX_BODY + 4);
		expect(decodeAscii(framed.subarray(0, 4))).toBe("ffff");
	});

	it("throws above the protocol limit instead of emitting a malformed frame", () => {
		expect(() => pktLineBuffer(new Uint8Array(MAX_BODY + 1))).toThrow(
			/65532 bytes exceeds the protocol limit of 65531/,
		);
		expect(() => pktLine("x".repeat(MAX_BODY + 1))).toThrow(
			/65532 bytes exceeds the protocol limit of 65531/,
		);
	});

	it("keeps chunking side-band data at the unchanged chunk size", () => {
		// SIDE_BAND_MAX_CHUNK (65515) plus the 0x01 band byte is 65516 body,
		// 65520 total = "fff0" — still a legal pkt-line.
		const framed = sideBandPackfile(new Uint8Array(65515));
		expect(decodeAscii(framed.subarray(0, 4))).toBe("fff0");
		expect(framed[4]).toBe(1);
	});
});
