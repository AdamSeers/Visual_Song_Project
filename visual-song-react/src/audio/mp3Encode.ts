import { Mp3Encoder } from 'lamejs'

export function encodeAudioBufferToMp3(buffer: AudioBuffer, kbps: number = 128): Blob {
    const sampleRate = buffer.sampleRate
    const channels = buffer.numberOfChannels
    const encoder = new Mp3Encoder(channels, sampleRate, kbps)

    // lamejs wants 16-bit PCM as Int16Array
    const left = floatTo16(buffer.getChannelData(0))
    const right = channels > 1 ? floatTo16(buffer.getChannelData(1)) : undefined

    const mp3Data: Int8Array[] = []
    const blockSize = 1152   // standard MP3 frame size
    for (let i = 0; i < left.length; i += blockSize) {
        const leftChunk = left.subarray(i, i + blockSize)
        const rightChunk = right ? right.subarray(i, i + blockSize) : undefined
        const encoded = encoder.encodeBuffer(leftChunk, rightChunk)
        if (encoded.length > 0) mp3Data.push(encoded)
    }
    const flushed = encoder.flush()
    if (flushed.length > 0) mp3Data.push(flushed)

    // Convert Int8Array chunks to ArrayBuffers explicitly typed.
    // lamejs's Int8Array might be backed by SharedArrayBuffer, which Blob rejects.
    const blobParts: ArrayBuffer[] = mp3Data.map(chunk => {
        const buf = new ArrayBuffer(chunk.length)
        new Uint8Array(buf).set(chunk)
        return buf
    })
    return new Blob(blobParts, { type: 'audio/mpeg' })
}

function floatTo16(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
}