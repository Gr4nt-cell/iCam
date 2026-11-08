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
import kotlin.math.*

/**
 * Two passes after recording: aspect-correct motion proxies, then a full-resolution export.
 * Proxies are ONLY measurements. Full-resolution HDR frames stay in Media3's
 * high-precision GL / HEVC pipeline; SDR uses AVC. Proxy pixels are never exported.
 */
@UnstableApi
internal object HdrVideoStabilizer {
  fun process(context: Context, source: File, crop: Float, rolls: List<RollSample>, strength: String = "cinematic", done: (File, String?) -> Unit) {
    val main = Handler(Looper.getMainLooper())
    val output = File(source.parentFile, source.nameWithoutExtension + "_stabilized.mp4")
    val finished = AtomicBoolean(false)
    fun finish(file: File, warning: String?) {
      if (!finished.compareAndSet(false, true)) return
      if (file != output) output.delete()
      done(file, warning)
    }
    Thread({
      try {
        val original = videoFormat(source)
        check(!original.hdr || Build.VERSION.SDK_INT >= 33) { "HDR editing requires Android 13" }
        val timeline = analyse(source, crop, rolls, strength)
        main.post {
          try {
            val effect = object : MatrixTransformation {
              private var width = 1; private var height = 1
              override fun configure(inputWidth: Int, inputHeight: Int): Size {
                width = inputWidth; height = inputHeight
                return Size(width, height)
              }
              override fun getMatrix(presentationTimeUs: Long): Matrix = Matrix().apply {
                setValues(VideoProcessingGeometry.matrix(timeline.at(presentationTimeUs), width, height, timeline.crop ?: crop))
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
              .setVideoMimeType(if (original.hdr) MimeTypes.VIDEO_H265 else MimeTypes.VIDEO_H264)
              .setEncoderFactory(encoder)
              .addListener(object : Transformer.Listener {
                override fun onFallbackApplied(c: Composition, originalRequest: TransformationRequest, fallback: TransformationRequest) {
                  // Transformer may propose SDR when the device cannot export HDR. Reject that.
                  if (original.hdr && (fallback.hdrMode != Composition.HDR_MODE_KEEP_HDR || fallback.videoMimeType != MimeTypes.VIDEO_H265)) {
                    transformer?.cancel()
                    finish(source, "This phone cannot process HDR without changing its format; saved the original video")
                  }
                }
                override fun onCompleted(c: Composition, result: ExportResult) {
                  if (finished.get()) return
                  try {
                    val exported = videoFormat(output)
                    check(!original.hdr || exported.transfer == original.transfer && exported.standard == original.standard) { "HDR colour metadata changed" }
                    check(exported.shortSide == original.shortSide && exported.longSide == original.longSide) { "HDR resolution changed" }
                    check(!original.hdr || exported.mime == MimeTypes.VIDEO_H265) { "HDR encoder changed" }
                    // Only remove the original after the completed HDR export has been checked.
                    source.delete()
                    finish(output, null)
                  } catch (_: Exception) {
                    finish(source, "Could not verify the processed video; saved the original video")
                  }
                }
                override fun onError(c: Composition, result: ExportResult, error: ExportException) {
                  finish(source, "Video stabilization was unavailable on this phone; saved the original video")
                }
              }).build()
            transformer.start(composition, output.absolutePath)
          } catch (_: Exception) {
            finish(source, "Video processing was unavailable; saved the original video")
          }
        }
      } catch (_: Exception) {
        main.post { finish(source, "Could not analyse stabilization; saved the original video") }
      }
    }, "iCamVideoAnalysis").start()
  }

  private data class HdrFormat(val transfer: Int, val standard: Int, val shortSide: Int, val longSide: Int, val bitrate: Int, val mime: String) { val hdr: Boolean get() = transfer == MediaFormat.COLOR_TRANSFER_HLG || transfer == MediaFormat.COLOR_TRANSFER_ST2084 }

  private fun videoFormat(file: File): HdrFormat {
    check(file.exists() && file.length() > 0)
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(file.absolutePath)
      val format = (0 until extractor.trackCount).map { extractor.getTrackFormat(it) }
        .first { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
      val transfer = if (format.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) format.getInteger(MediaFormat.KEY_COLOR_TRANSFER) else 0
      val standard = if (format.containsKey(MediaFormat.KEY_COLOR_STANDARD)) format.getInteger(MediaFormat.KEY_COLOR_STANDARD) else 0
      if (transfer == MediaFormat.COLOR_TRANSFER_HLG || transfer == MediaFormat.COLOR_TRANSFER_ST2084) check(standard == MediaFormat.COLOR_STANDARD_BT2020) { "Not BT.2020" }
      val width = format.getInteger(MediaFormat.KEY_WIDTH); val height = format.getInteger(MediaFormat.KEY_HEIGHT)
      val bitrate = if (format.containsKey(MediaFormat.KEY_BIT_RATE)) format.getInteger(MediaFormat.KEY_BIT_RATE) else if (maxOf(width,height) >= 3840) 60_000_000 else 24_000_000
      return HdrFormat(transfer,standard,minOf(width,height),maxOf(width,height),bitrate.coerceAtLeast(10_000_000),format.getString(MediaFormat.KEY_MIME)!!)
    } finally { extractor.release() }
  }

  private fun analyse(source: File, crop: Float, rolls: List<RollSample>, strength: String): VideoProcessingTimeline {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(source.absolutePath)
      val durationUs = (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) * 1000
      check(durationUs > 0)
      val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 1920
      val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 1080
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val uprightWidth = if (rotation % 180 != 0) rawHeight else rawWidth
      val uprightHeight = if (rotation % 180 != 0) rawWidth else rawHeight
      // Preserve aspect ratio: rotation estimation is invalid on a stretched portrait proxy.
      val width = if (uprightWidth >= uprightHeight) 320 else max(80,320*uprightWidth/uprightHeight)
      val height = if (uprightHeight >= uprightWidth) 320 else max(80,320*uprightHeight/uprightWidth)
      val frameCount = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toDoubleOrNull()
      val fps = (frameCount?.let { it*1e6/durationUs } ?: 30.0).roundToInt().coerceIn(24,60)
      val step = (1e6/fps).roundToLong()
      val times=ArrayList<Long>();val motions=ArrayList<FrameMotion>();val cuts=HashSet<Int>()
      val pixels = IntArray(width*height)
      var previous: IntArray? = null
      var time = 0L
      while (time < durationUs) {
        val raw = retriever.getScaledFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST, width, height)
          ?: throw IllegalStateException("No motion proxy")
        val proxy = if (raw.width == width && raw.height == height) raw else Bitmap.createScaledBitmap(raw,width,height,true)
        try { proxy.getPixels(pixels,0,width,0,0,width,height) } finally { if (proxy !== raw) proxy.recycle(); raw.recycle() }
        val luma = IntArray(pixels.size) { i -> val p=pixels[i]; (((p ushr 16) and 255)*54 + ((p ushr 8) and 255)*183 + (p and 255)*19) ushr 8 }
        val motion = previous?.let { OfflineVideoMotion.estimate(it,luma,width,height) } ?: FrameMotion(0.0,0.0,0.0,false)
        if(!motion.reliable && previous!=null){
          val prev=previous!!;val bias=luma.indices.step(16).map{luma[it]-prev[it]}.average()
          val difference=luma.indices.step(16).map{abs(luma[it]-prev[it]-bias)}.average()
          if(difference>45)cuts.add(times.size)
        }
        times.add(time);motions.add(motion)
        previous=luma;time+=step
      }
      check(motions.count{it.reliable} >= maxOf(4,(motions.size*.65).toInt())) { "Not enough reliable camera motion" }
      return OfflineVideoPath.build(OfflineVideoPath.integrate(times,motions,cuts),width,height,crop,strength,rolls)
    } finally { retriever.release() }
  }
}
