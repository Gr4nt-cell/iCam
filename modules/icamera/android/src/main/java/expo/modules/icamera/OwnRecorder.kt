package expo.modules.icamera

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer

/**
 * iCam's own video recorder (Video / Action modes). The GPU pipeline draws every frame into
 * [surface] at a fixed size, so the camera feeding it can change (front ↔ back) mid-clip without the
 * recording restarting. H.264 video + AAC audio, muxed to MP4; pause/resume supported.
 *
 * Frames are encoded landscape with a 90° orientation tag (players show them upright/portrait).
 * Timestamps for audio and video come from the same monotonic clock, minus paused time.
 */
class OwnRecorder(
  private val file: File,
  requestedW: Int,
  requestedH: Int,
  fps: Int,
  bitrate: Int,
  private val withAudio: Boolean,
  /** Clockwise degrees players rotate the frames by (how the phone was held when recording started) */
  orientationHint: Int = 90,
) {
  val width: Int
  val height: Int
  val surface: Surface

  private val video: MediaCodec
  private var audio: MediaCodec? = null
  private var audioRecord: AudioRecord? = null
  private val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  private var videoTrack = -1
  private var audioTrack = -1
  private var muxerStarted = false
  private val pending = ArrayList<Triple<Int, ByteBuffer, MediaCodec.BufferInfo>>()
  private val lock = Object()

  @Volatile private var stopping = false
  @Volatile var paused = false
    private set
  private var pauseStartNs = 0L
  @Volatile private var pausedTotalNs = 0L
  private val startNs = System.nanoTime()
  private var lastVideoPtsUs = -1L
  private var lastAudioPtsUs = -1L
  private var firstPtsUs = -1L
  private var lastPtsUs = 0L
  private var videoEos = false
  private var audioEos = true
  private var drainThread: Thread? = null
  private var audioThread: Thread? = null
  @Volatile private var error: String? = null

  init {
    val (w, h) = pickSize(requestedW, requestedH)
    width = w
    height = h
    val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    video = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    video.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    surface = video.createInputSurface()
    muxer.setOrientationHint(((orientationHint % 360) + 360) % 360)
    if (withAudio) setupAudio()
  }

  /** Largest size ≤ the request that the phone's H.264 encoder accepts (falls back to 1080p / 720p). */
  private fun pickSize(w: Int, h: Int): Pair<Int, Int> {
    val caps = try {
      MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
        .filter { it.isEncoder && it.supportedTypes.any { t -> t.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } }
        .map { it.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities }
    } catch (e: Throwable) { emptyList() }
    for ((cw, ch) in listOf(w to h, 1920 to 1080, 1280 to 720)) {
      if (caps.isEmpty() || caps.any { it.isSizeSupported(cw, ch) }) return cw to ch
    }
    return 1280 to 720
  }

  @SuppressLint("MissingPermission")
  private fun setupAudio() {
    try {
      val rate = 48000
      val ch = AudioFormat.CHANNEL_IN_STEREO
      val minBuf = AudioRecord.getMinBufferSize(rate, ch, AudioFormat.ENCODING_PCM_16BIT)
      if (minBuf <= 0) return
      val rec = AudioRecord(MediaRecorder.AudioSource.CAMCORDER, rate, ch, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf * 4, 16384))
      if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }
      val af = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 2).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, 192_000)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
      }
      val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      enc.configure(af, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      audioRecord = rec
      audio = enc
      audioEos = false
    } catch (e: Throwable) {
      audioRecord = null
      audio = null
      audioEos = true
    }
  }

  fun start() {
    video.start()
    audio?.start()
    audioRecord?.startRecording()
    drainThread = Thread({ drainLoop() }, "iCamRecDrain").apply { start() }
    if (audio != null) audioThread = Thread({ audioLoop() }, "iCamRecAudio").apply { start() }
  }

  /** Presentation time (ns) for the next video frame, or -1 to skip it (paused / stopping). */
  fun nextVideoPtsNs(): Long {
    if (paused || stopping) return -1L
    return System.nanoTime() - pausedTotalNs
  }

  fun pause() {
    if (paused) return
    pauseStartNs = System.nanoTime()
    paused = true
  }

  fun resume() {
    if (!paused) return
    pausedTotalNs += System.nanoTime() - pauseStartNs
    paused = false
  }

  private fun audioLoop() {
    val rec = audioRecord ?: return
    val enc = audio ?: return
    val rate = 48000
    val bytesPerFrame = 4 // 16-bit stereo
    val buf = ByteArray(4096)
    var samples = 0L // frames delivered to the encoder (paused audio is dropped, not counted)
    val baseUs = (System.nanoTime() - startNs) / 1000
    try {
      while (true) {
        val n = rec.read(buf, 0, buf.size)
        if (stopping) {
          val idx = enc.dequeueInputBuffer(10_000)
          if (idx >= 0) enc.queueInputBuffer(idx, 0, 0, (startNs / 1000) + baseUs + samples * 1_000_000L / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
          break
        }
        if (n <= 0 || paused) continue
        val idx = enc.dequeueInputBuffer(10_000)
        if (idx < 0) continue
        val ib = enc.getInputBuffer(idx) ?: continue
        ib.clear()
        val len = minOf(n, ib.remaining())
        ib.put(buf, 0, len)
        val ptsUs = (startNs / 1000) + baseUs + samples * 1_000_000L / rate
        enc.queueInputBuffer(idx, 0, len, ptsUs, 0)
        samples += len / bytesPerFrame
      }
    } catch (e: Throwable) {
      error = error ?: "Audio: ${e.message}"
      audioEos = true
    }
  }

  private fun drainLoop() {
    val info = MediaCodec.BufferInfo()
    try {
      while (!(videoEos && audioEos)) {
        if (!videoEos) drain(video, info, true)
        val a = audio
        if (a != null && !audioEos) drain(a, info, false)
      }
    } catch (e: Throwable) {
      error = error ?: "Encoder: ${e.message}"
    }
  }

  private fun drain(codec: MediaCodec, info: MediaCodec.BufferInfo, isVideo: Boolean) {
    val idx = codec.dequeueOutputBuffer(info, 5_000)
    when {
      idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> synchronized(lock) {
        if (isVideo) videoTrack = muxer.addTrack(codec.outputFormat) else audioTrack = muxer.addTrack(codec.outputFormat)
        val ready = videoTrack >= 0 && (audio == null || audioTrack >= 0)
        if (ready && !muxerStarted) {
          muxer.start()
          muxerStarted = true
          for ((t, b, i) in pending) writeSample(t, b, i)
          pending.clear()
        }
      }
      idx >= 0 -> {
        val out = codec.getOutputBuffer(idx)
        if (out != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
          synchronized(lock) {
            val track = if (isVideo) videoTrack else audioTrack
            if (muxerStarted) writeSample(track, out, info)
            else {
              // keep until both tracks exist
              val copy = ByteBuffer.allocateDirect(info.size)
              out.position(info.offset); out.limit(info.offset + info.size)
              copy.put(out); copy.flip()
              val ci = MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) }
              pending.add(Triple(if (isVideo) -1 else -2, copy, ci))
            }
          }
        }
        codec.releaseOutputBuffer(idx, false)
        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
          if (isVideo) videoEos = true else audioEos = true
        }
      }
    }
  }

  /** Writes one sample with strictly increasing timestamps per track. */
  private fun writeSample(trackOrTag: Int, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
    val isVideo = trackOrTag == -1 || trackOrTag == videoTrack
    val track = if (trackOrTag == -1) videoTrack else if (trackOrTag == -2) audioTrack else trackOrTag
    if (track < 0) return
    var pts = info.presentationTimeUs
    if (isVideo) { if (pts <= lastVideoPtsUs) pts = lastVideoPtsUs + 1; lastVideoPtsUs = pts }
    else { if (pts <= lastAudioPtsUs) pts = lastAudioPtsUs + 1; lastAudioPtsUs = pts }
    if (firstPtsUs < 0) firstPtsUs = pts
    lastPtsUs = maxOf(lastPtsUs, pts)
    val i = MediaCodec.BufferInfo().apply { set(info.offset, info.size, pts, info.flags) }
    muxer.writeSampleData(track, buf, i)
  }

  /** Finishes the file on a background thread; [done] gets (ok, durationMs, error). */
  fun stop(done: (Boolean, Double, String?) -> Unit) {
    if (stopping) return
    if (paused) resume()
    stopping = true
    Thread({
      try { video.signalEndOfInputStream() } catch (_: Throwable) { videoEos = true }
      try { audioThread?.join(3000) } catch (_: Throwable) {}
      try { drainThread?.join(5000) } catch (_: Throwable) {}
      var ok = false
      try {
        if (muxerStarted) { muxer.stop(); ok = file.exists() && file.length() > 0 }
      } catch (e: Throwable) { error = error ?: "Muxer: ${e.message}" }
      try { muxer.release() } catch (_: Throwable) {}
      try { video.stop() } catch (_: Throwable) {}
      try { video.release() } catch (_: Throwable) {}
      try { audio?.stop() } catch (_: Throwable) {}
      try { audio?.release() } catch (_: Throwable) {}
      try { audioRecord?.stop() } catch (_: Throwable) {}
      try { audioRecord?.release() } catch (_: Throwable) {}
      try { surface.release() } catch (_: Throwable) {}
      val durMs = if (firstPtsUs >= 0) (lastPtsUs - firstPtsUs) / 1000.0 else 0.0
      done(ok, durMs, if (ok) null else error ?: "Nothing was recorded")
    }, "iCamRecStop").start()
  }
}
