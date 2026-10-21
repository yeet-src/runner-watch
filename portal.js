/* Wire format for the tty portal, isolate side. A frame rides in an OSC sequence with the JSON lifted to
 * pure ASCII so the line discipline cannot rewrite a byte of it. */
export const OSC_OPEN = "\x1b]7880;";
export const OSC_CLOSE = "\x07";

export function encodeFrame(message) {
  return `${OSC_OPEN}${ascii(JSON.stringify(message))}${OSC_CLOSE}`;
}

function ascii(json) {
  let out = "";
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return out;
}
