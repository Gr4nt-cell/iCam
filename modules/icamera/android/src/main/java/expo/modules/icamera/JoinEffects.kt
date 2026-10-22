package expo.modules.icamera

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.RgbMatrix
import java.nio.ByteBuffer

/**
 * Smooth joins between the pieces of a multi-camera video: the sound fades out at the end of a
 * piece and back in at the start of the next, so a camera switch has no click or abrupt cut.
 */
@UnstableApi
class EdgeFadeAudioProcessor(
  private val fadeInUs: Long,
  private val fadeOutUs: Long,
  private val durationUs: Long,
) : BaseAudioProcessor() {
  private var frames = 0L

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val ch = inputAudioFormat.channelCount
    val rate = inputAudioFormat.sampleRate
    val out = replaceOutputBuffer(inputBuffer.remaining())
    while (inputBuffer.remaining() >= 2 * ch) {
      val tUs = frames * 1_000_000L / rate
      var g = 1f
      if (fadeInUs > 0 && tUs < fadeInUs) g = tUs.toFloat() / fadeInUs
      if (fadeOutUs > 0 && durationUs > 0 && tUs > durationUs - fadeOutUs) {
        g = minOf(g, maxOf(0f, (durationUs - tUs).toFloat() / fadeOutUs))
      }
      for (c in 0 until ch) out.putShort((inputBuffer.short * g).toInt().toShort())
      frames++
    }
    inputBuffer.position(inputBuffer.limit())
    out.flip()
  }

  override fun onFlush() { frames = 0 }
}

/**
 * Picture side of the join: a short dip (to ~35 % brightness and back) at the start and/or end of a
 * piece, so the cut between cameras reads as a quick blink instead of a hard jump.
 */
@UnstableApi
class EdgeDip(private val durationUs: Long, private val inUs: Long, private val outUs: Long) : RgbMatrix {
  override fun getMatrix(presentationTimeUs: Long, useHdr: Boolean): FloatArray {
    var k = 1f
    if (inUs > 0 && presentationTimeUs < inUs) k = 0.35f + 0.65f * (presentationTimeUs.toFloat() / inUs).coerceIn(0f, 1f)
    if (outUs > 0 && durationUs > 0 && presentationTimeUs > durationUs - outUs) {
      k = minOf(k, 0.35f + 0.65f * ((durationUs - presentationTimeUs).toFloat() / outUs).coerceIn(0f, 1f))
    }
    return floatArrayOf(k, 0f, 0f, 0f, 0f, k, 0f, 0f, 0f, 0f, k, 0f, 0f, 0f, 0f, 1f)
  }
}
