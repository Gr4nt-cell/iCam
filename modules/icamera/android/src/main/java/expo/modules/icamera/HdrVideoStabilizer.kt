package expo.modules.icamera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.MatrixTransformation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.TransformationRequest
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.exp

/**
 * Two passes after recording: small disposable motion proxies, then an HDR-preserving export.
 * Proxies are ONLY measurements. Full-resolution HDR frames go directly through Media3's HDR
 * decoder / high-precision GL / HEVC encoder; never through PortraitProcessor's 8-bit buffers.
 */
@UnstableApi
internal object HdrVideoStabilizer {
  fun process(context: Context, source: File, crop: Float, rolls: List<RollSample>, done: (File, String?) -> Unit) {
    val main = Handler(Looper.getMainLooper())
    val output = File(source.parentFile, source.nameWithoutExtension + "_stabilized_hdr.mp4")
    val finished = AtomicBoolean(false)
    fun finish(file: File, warning: String?) {
      if (!finished.compareAndSet(false, true)) return
      if (file != output) output.delete()
      done(file, warning)
    }
    if (Build.VERSION.SDK_INT < 33) {
      finish(source, "HDR processing needs Android 13 or later; saved the original HDR video")
      return
    }
    Thread({
      try {
        val original = hdrFormat(source)
        val timeline = analyse(source, crop, rolls)
        main.post {
          try {
            val effect = object : MatrixTransformation {
              private var width = 1; private var height = 1
              override fun configure(inputWidth: Int, inputHeight: Int): Size {
                width = inputWidth; height = inputHeight
                return Size(width, height)
              }
              override fun getMatrix(presentationTimeUs: Long): Matrix = Matrix().apply {
                setValues(VideoProcessingGeometry.matrix(timeline.at(presentationTimeUs), width, height, crop))
              }
            }
            val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(source)))
              .setEffects(Effects(emptyList(), listOf(effect))).build()
            val composition = Composition.Builder(listOf(EditedMediaItemSequence(listOf(item))))
              .setHdrMode(Composition.HDR_MODE_KEEP_HDR).build()
            var transformer: Transformer? = null
            val encoder = DefaultEncoderFactory.Builder(context)
              .setEnableFallback(false)
              .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(original.bitrate).build())
              .build()
            transformer = Transformer.Builder(context)
              .setVideoMimeType(MimeTypes.VIDEO_H265)
              .setEncoderFactory(encoder)
              .addListener(object : Transformer.Listener {
                override fun onFallbackApplied(c: Composition, originalRequest: TransformationRequest, fallback: TransformationRequest) {
                  // Transformer may propose SDR when the device cannot export HDR. Reject that.
                  if (fallback.hdrMode != Composition.HDR_MODE_KEEP_HDR || fallback.videoMimeType != MimeTypes.VIDEO_H265) {
                    transformer?.cancel()
                    finish(source, "This phone cannot process HDR without changing its format; saved the original HDR video")
                  }
                }
                override fun onCompleted(c: Composition, result: ExportResult) {
                  if (finished.get()) return
                  try {
                    val exported = hdrFormat(output)
                    check(exported.transfer == original.transfer && exported.standard == original.standard) { "HDR colour metadata changed" }
                    check(exported.shortSide == original.shortSide && exported.longSide == original.longSide) { "HDR resolution changed" }
                    check(exported.mime == MimeTypes.VIDEO_H265) { "HDR encoder changed" }
                    // Only remove the original after the completed HDR export has been checked.
                    source.delete()
                    finish(output, null)
                  } catch (_: Exception) {
                    finish(source, "Could not verify the processed HDR video; saved the original HDR video")
                  }
                }
                override fun onError(c: Composition, result: ExportResult, error: ExportException) {
                  finish(source, "HDR stabilization was unavailable on this phone; saved the original HDR video")
                }
              }).build()
            transformer.start(composition, output.absolutePath)
          } catch (_: Exception) {
            finish(source, "HDR processing was unavailable; saved the original HDR video")
          }
        }
      } catch (_: Exception) {
        main.post { finish(source, "Could not analyse HDR stabilization; saved the original HDR video") }
      }
    }, "iCamHdrAnalysis").start()
  }

  private data class HdrFormat(val transfer: Int, val standard: Int, val shortSide: Int, val longSide: Int, val bitrate: Int, val mime: String)

  private fun hdrFormat(file: File): HdrFormat {
    check(file.exists() && file.length() > 0)
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(file.absolutePath)
      val format = (0 until extractor.trackCount).map { extractor.getTrackFormat(it) }
        .first { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
      val transfer = format.getInteger(MediaFormat.KEY_COLOR_TRANSFER)
      val standard = format.getInteger(MediaFormat.KEY_COLOR_STANDARD)
      check(transfer == MediaFormat.COLOR_TRANSFER_HLG || transfer == MediaFormat.COLOR_TRANSFER_ST2084) { "Not HDR" }
      check(standard == MediaFormat.COLOR_STANDARD_BT2020) { "Not BT.2020" }
      val width = format.getInteger(MediaFormat.KEY_WIDTH); val height = format.getInteger(MediaFormat.KEY_HEIGHT)
      val bitrate = if (format.containsKey(MediaFormat.KEY_BIT_RATE)) format.getInteger(MediaFormat.KEY_BIT_RATE) else if (maxOf(width,height) >= 3840) 60_000_000 else 24_000_000
      return HdrFormat(transfer,standard,minOf(width,height),maxOf(width,height),bitrate.coerceAtLeast(10_000_000),format.getString(MediaFormat.KEY_MIME)!!)
    } finally { extractor.release() }
  }

  private fun analyse(source: File, crop: Float, rolls: List<RollSample>): VideoProcessingTimeline {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(source.absolutePath)
      val durationUs = (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) * 1000
      check(durationUs > 0)
      val path = VideoCameraPath()
      val samples = ArrayList<VideoProcessingSample>()
      val pixels = IntArray(160 * 90)
      var previous: IntArray? = null
      var lastTime = 0L; var lastRoll = rolls.firstOrNull()?.radians ?: 0f
      var rollIndex = 0
      // 30 measurement samples per second; Media3 interpolates transforms at the original frame rate.
      var time = 0L
      while (time < durationUs) {
        val raw = retriever.getScaledFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST, 160, 90)
          ?: throw IllegalStateException("No motion proxy")
        val proxy = if (raw.width == 160 && raw.height == 90) raw else Bitmap.createScaledBitmap(raw,160,90,true)
        try { proxy.getPixels(pixels,0,160,0,0,160,90) } finally { if (proxy !== raw) proxy.recycle(); raw.recycle() }
        val luma = IntArray(pixels.size) { i -> val p=pixels[i]; (((p ushr 16) and 255)*54 + ((p ushr 8) and 255)*183 + (p and 255)*19) ushr 8 }
        val dt = if (previous == null) 1.0/30 else (time-lastTime)/1e6
        val motion = previous?.let { VideoMotionEstimator.estimate(it,luma,160,90) }
        val shift = path.update((motion?.get(0) ?: 0.0)/160, (motion?.get(1) ?: 0.0)/90, dt, crop, motion != null)
        while (rollIndex + 1 < rolls.size && rolls[rollIndex+1].timeUs <= time) rollIndex++
        val a = rolls.getOrNull(rollIndex); val b = rolls.getOrNull(rollIndex+1)
        val roll = if (a != null && b != null) {
          val f = ((time-a.timeUs).toDouble()/(b.timeUs-a.timeUs).coerceAtLeast(1)).coerceIn(0.0,1.0).toFloat()
          a.radians+(b.radians-a.radians)*f
        } else a?.radians ?: 0f
        lastRoll += (roll-lastRoll) * (1-exp(-dt/.16)).toFloat()
        samples.add(VideoProcessingSample(time,shift[0],shift[1],lastRoll))
        previous = luma; lastTime = time; time += 33_333L
      }
      return VideoProcessingTimeline(samples)
    } finally { retriever.release() }
  }
}
