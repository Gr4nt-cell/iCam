package expo.modules.icamera

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Fast join for clips recorded front ↔ back in one session.
 *
 * The pieces come from the same recorder at the same size and rotation, so their H.264 video can
 * be copied straight into one file without decoding or re-encoding (the slow part of a join). Only
 * the sound is re-encoded, which is quick, so it can fade out and in at each join.
 * Returns false if the pieces aren't compatible (the caller then falls back to a full re-encode).
 */
object FastJoin {
  private const val FADE_US = 120_000L

  private class Piece(val file: File, val vTrack: Int, val aTrack: Int, val vFormat: MediaFormat, val aFormat: MediaFormat?)

  fun join(parts: List<File>, out: File): Boolean {
    val pieces = parts.map { open(it) ?: return false }
    if (!compatible(pieces)) return false
    // Where each piece starts on the joined timeline (its own first frame = 0)
    val starts = LongArray(pieces.size)
    val lengths = LongArray(pieces.size)
    for ((i, p) in pieces.withIndex()) {
      lengths[i] = videoLengthUs(p)
      if (i > 0) starts[i] = starts[i - 1] + lengths[i - 1]
    }
    val withAudio = pieces.all { it.aFormat != null }
    val audio = if (withAudio) encodeAudio(pieces, starts, lengths) ?: return false else null

    var muxer: MediaMuxer? = null
    try {
      muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val vf = pieces[0].vFormat
      if (vf.containsKey(MediaFormat.KEY_ROTATION)) muxer.setOrientationHint(vf.getInteger(MediaFormat.KEY_ROTATION))
      val vOut = muxer.addTrack(vf)
      val aOut = if (audio != null) muxer.addTrack(audio.format) else -1
      muxer.start()

      var ai = 0
      val buf = ByteBuffer.allocateDirect(maxSample(pieces))
      val info = MediaCodec.BufferInfo()
      var lastV = -1L
      for ((i, p) in pieces.withIndex()) {
        val ex = MediaExtractor()
        try {
          ex.setDataSource(p.file.absolutePath)
          ex.selectTrack(p.vTrack)
          var first = -1L
          while (true) {
            buf.clear()
            val n = ex.readSampleData(buf, 0)
            if (n < 0) break
            val t = ex.sampleTime
            if (first < 0) first = t
            var pts = starts[i] + (t - first)
            if (pts <= lastV) pts = lastV + 1
            // interleave: write any sound that belongs before this frame
            if (audio != null) {
              while (ai < audio.samples.size && audio.samples[ai].second.presentationTimeUs <= pts) {
                val (data, ainfo) = audio.samples[ai++]
                muxer.writeSampleData(aOut, data, ainfo)
              }
            }
            val key = (ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0
            info.set(0, n, pts, if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            muxer.writeSampleData(vOut, buf, info)
            lastV = pts
            ex.advance()
          }
        } finally { ex.release() }
      }
      if (audio != null) while (ai < audio.samples.size) {
        val (data, ainfo) = audio.samples[ai++]
        muxer.writeSampleData(aOut, data, ainfo)
      }
      muxer.stop()
      return out.exists() && out.length() > 0
    } catch (e: Throwable) {
      try { out.delete() } catch (_: Throwable) {}
      return false
    } finally {
      try { muxer?.release() } catch (_: Throwable) {}
    }
  }

  private fun open(f: File): Piece? {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(f.absolutePath)
      var v = -1; var a = -1
      var vf: MediaFormat? = null; var af: MediaFormat? = null
      for (t in 0 until ex.trackCount) {
        val fmt = ex.getTrackFormat(t)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/") && v < 0) { v = t; vf = fmt }
        if (mime.startsWith("audio/") && a < 0) { a = t; af = fmt }
      }
      return if (vf != null) Piece(f, v, a, vf, af) else null
    } catch (e: Throwable) {
      return null
    } finally { ex.release() }
  }

  /** Same codec, size, rotation and codec set-up data, so the copied frames play as one stream. */
  private fun compatible(ps: List<Piece>): Boolean {
    val a = ps[0].vFormat
    fun int(f: MediaFormat, k: String) = if (f.containsKey(k)) f.getInteger(k) else 0
    fun bytes(f: MediaFormat, k: String): ByteArray? = f.getByteBuffer(k)?.let { b ->
      val d = b.duplicate(); d.rewind(); ByteArray(d.remaining()).also { d.get(it) }
    }
    for (p in ps.drop(1)) {
      val b = p.vFormat
      if (a.getString(MediaFormat.KEY_MIME) != b.getString(MediaFormat.KEY_MIME)) return false
      if (int(a, MediaFormat.KEY_WIDTH) != int(b, MediaFormat.KEY_WIDTH)) return false
      if (int(a, MediaFormat.KEY_HEIGHT) != int(b, MediaFormat.KEY_HEIGHT)) return false
      if (int(a, MediaFormat.KEY_ROTATION) != int(b, MediaFormat.KEY_ROTATION)) return false
      if (!bytes(a, "csd-0").contentEquals(bytes(b, "csd-0"))) return false
      if (!bytes(a, "csd-1").contentEquals(bytes(b, "csd-1"))) return false
    }
    return true
  }

  private fun maxSample(ps: List<Piece>): Int {
    var m = 2 * 1024 * 1024
    for (p in ps) if (p.vFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) m = maxOf(m, p.vFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
    return m
  }

  /** Length of a piece's video: last frame time − first + one frame. */
  private fun videoLengthUs(p: Piece): Long {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(p.file.absolutePath)
      ex.selectTrack(p.vTrack)
      var first = -1L; var last = 0L; var n = 0
      while (true) {
        val t = ex.sampleTime
        if (t < 0) break
        if (first < 0) first = t
        if (t > last) last = t
        n++
        ex.advance()
      }
      if (first < 0) return 0L
      val frame = if (n > 1) (last - first) / (n - 1) else 33_333L
      return last - first + frame
    } finally { ex.release() }
  }

  private class Audio(val format: MediaFormat, val samples: List<Pair<ByteBuffer, MediaCodec.BufferInfo>>)

  /**
   * Decodes each piece's sound, places it at that piece's start (padding with silence or dropping a
   * few ms so it stays in sync with the picture), fades it at the joins and encodes it as one AAC track.
   */
  private fun encodeAudio(ps: List<Piece>, starts: LongArray, lengths: LongArray): Audio? {
    var enc: MediaCodec? = null
    try {
      var rate = 0; var ch = 0
      var written = 0L // frames (per-channel samples) fed to the encoder
      val samples = ArrayList<Pair<ByteBuffer, MediaCodec.BufferInfo>>()
      var outFormat: MediaFormat? = null
      val einfo = MediaCodec.BufferInfo()

      fun drainEncoder(endOfStream: Boolean) {
        val e = enc ?: return
        while (true) {
          val idx = e.dequeueOutputBuffer(einfo, if (endOfStream) 10_000 else 0)
          if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) { if (!endOfStream) return else continue }
          if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { outFormat = e.outputFormat; continue }
          if (idx < 0) continue
          val ob = e.getOutputBuffer(idx)
          if (ob != null && einfo.size > 0 && (einfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
            ob.position(einfo.offset); ob.limit(einfo.offset + einfo.size)
            val copy = ByteBuffer.allocateDirect(einfo.size).order(ByteOrder.nativeOrder())
            copy.put(ob); copy.flip()
            samples.add(copy to MediaCodec.BufferInfo().apply { set(0, einfo.size, einfo.presentationTimeUs, einfo.flags) })
          }
          val eos = (einfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
          e.releaseOutputBuffer(idx, false)
          if (eos) return
        }
      }

      /** Feeds 16-bit PCM to the encoder in chunks it can take. */
      fun feed(pcm: ShortArray, count: Int) {
        val e = enc ?: return
        var off = 0
        while (off < count) {
          val idx = e.dequeueInputBuffer(10_000)
          if (idx < 0) { drainEncoder(false); continue }
          val ib = e.getInputBuffer(idx) ?: continue
          ib.clear()
          val n = minOf(count - off, ib.remaining() / 2) / ch * ch
          if (n <= 0) { e.queueInputBuffer(idx, 0, 0, written * 1_000_000L / rate, 0); continue }
          ib.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm, off, n)
          e.queueInputBuffer(idx, 0, n * 2, written * 1_000_000L / rate, 0)
          written += n / ch
          off += n
          drainEncoder(false)
        }
      }

      for ((i, p) in ps.withIndex()) {
        val ex = MediaExtractor()
        var dec: MediaCodec? = null
        try {
          ex.setDataSource(p.file.absolutePath)
          // timeline zero of the piece = its first video frame
          ex.selectTrack(p.vTrack)
          val base = ex.sampleTime.coerceAtLeast(0L)
          ex.unselectTrack(p.vTrack)
          ex.selectTrack(p.aTrack)
          val af = p.aFormat!!
          dec = MediaCodec.createDecoderByType(af.getString(MediaFormat.KEY_MIME)!!)
          dec.configure(af, null, null, 0)
          dec.start()
          val dinfo = MediaCodec.BufferInfo()
          var inDone = false
          var placed = false
          val fadeIn = i > 0
          val fadeOut = i < ps.size - 1
          val len = lengths[i]
          var pcm = ShortArray(0)
          while (true) {
            if (!inDone) {
              val idx = dec.dequeueInputBuffer(5_000)
              if (idx >= 0) {
                val ib = dec.getInputBuffer(idx)!!
                val n = ex.readSampleData(ib, 0)
                if (n < 0) { dec.queueInputBuffer(idx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true }
                else { dec.queueInputBuffer(idx, 0, n, ex.sampleTime, 0); ex.advance() }
              }
            }
            val oi = dec.dequeueOutputBuffer(dinfo, 5_000)
            if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
            if (oi < 0) { if (inDone && oi == MediaCodec.INFO_TRY_AGAIN_LATER) continue else continue }
            val eos = (dinfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
            val ob = dec.getOutputBuffer(oi)
            if (ob != null && dinfo.size > 0) {
              val fmt = dec.outputFormat
              val r = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              val c = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              if (fmt.containsKey(MediaFormat.KEY_PCM_ENCODING) && fmt.getInteger(MediaFormat.KEY_PCM_ENCODING) != android.media.AudioFormat.ENCODING_PCM_16BIT) {
                throw IllegalStateException("float pcm")
              }
              if (enc == null) {
                rate = r; ch = c
                val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, ch).apply {
                  setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                  setInteger(MediaFormat.KEY_BIT_RATE, 192_000)
                  setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 16)
                }
                enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).also {
                  it.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); it.start()
                }
              } else if (r != rate || c != ch) throw IllegalStateException("audio format differs")

              ob.position(dinfo.offset); ob.limit(dinfo.offset + dinfo.size)
              val sb = ob.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
              var count = sb.remaining()
              if (pcm.size < count) pcm = ShortArray(count)
              sb.get(pcm, 0, count)
              var t0 = dinfo.presentationTimeUs - base // this buffer's time within the piece
              var skip = 0
              if (!placed) {
                // line the piece's sound up with its picture: pad with silence or drop the excess
                val want = (starts[i] + maxOf(0L, t0)) * rate / 1_000_000L
                if (written < want) {
                  val gap = ((want - written) * ch).toInt()
                  feed(ShortArray(gap), gap)
                } else if (written > want) {
                  skip = (((written - want) * ch).toInt()).coerceAtMost(count) / ch * ch
                  t0 += (skip / ch) * 1_000_000L / rate
                }
                placed = true
              }
              // drop sound past the end of the piece's picture
              val maxFrames = ((len - t0) * rate / 1_000_000L).coerceAtLeast(0L)
              count = minOf(count, skip + (maxFrames * ch).toInt())
              // fades at the joins
              if (fadeIn || fadeOut) {
                var k = skip
                while (k < count) {
                  val t = t0 + ((k - skip) / ch) * 1_000_000L / rate
                  var g = 1f
                  if (fadeIn && t < FADE_US) g = minOf(g, t.toFloat() / FADE_US)
                  if (fadeOut && t > len - FADE_US) g = minOf(g, (len - t).toFloat() / FADE_US)
                  if (g < 1f) {
                    val gg = g.coerceIn(0f, 1f)
                    for (c2 in 0 until ch) pcm[k + c2] = (pcm[k + c2] * gg).toInt().toShort()
                  }
                  k += ch
                }
              }
              if (count > skip) {
                val chunk = if (skip == 0) pcm else pcm.copyOfRange(skip, count)
                feed(chunk, count - skip)
              }
            }
            dec.releaseOutputBuffer(oi, false)
            if (eos) break
          }
        } finally {
          try { dec?.stop() } catch (_: Throwable) {}
          try { dec?.release() } catch (_: Throwable) {}
          ex.release()
        }
      }
      val e = enc ?: return null
      // end of stream
      while (true) {
        val idx = e.dequeueInputBuffer(10_000)
        if (idx >= 0) { e.queueInputBuffer(idx, 0, 0, written * 1_000_000L / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM); break }
        drainEncoder(false)
      }
      drainEncoder(true)
      val f = outFormat ?: return null
      return Audio(f, samples)
    } catch (e: Throwable) {
      return null
    } finally {
      try { enc?.stop() } catch (_: Throwable) {}
      try { enc?.release() } catch (_: Throwable) {}
    }
  }
}
