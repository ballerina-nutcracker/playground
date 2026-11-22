const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const strictDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

export function encodeText(text: string): Uint8Array {
	return encoder.encode(text);
}

/** Decodes UTF-8, replacing invalid sequences with U+FFFD. */
export function decodeText(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/** Decodes UTF-8, or returns null when the bytes are not valid UTF-8. */
export function tryDecodeText(bytes: Uint8Array): string | null {
	try {
		return strictDecoder.decode(bytes);
	} catch {
		return null;
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
