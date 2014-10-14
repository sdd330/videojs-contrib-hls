(function(window) {
  var
    videojs = window.videojs,
    mp4bytes,
    FlvTag = videojs.Hls.FlvTag,
    H264Stream = videojs.Hls.H264Stream,
    AacStream = videojs.Hls.AacStream,
    MP2T_PACKET_LENGTH,
    STREAM_TYPES;

  /**
   * An object that incrementally transmuxes MPEG2 Trasport Stream
   * chunks into an FLV.
   */
  videojs.Hls.SegmentParser = function() {
    var
      self = this,
      parseTSPacket,
      streamBuffer = new Uint8Array(MP2T_PACKET_LENGTH),
      streamBufferByteCount = 0,
      h264Stream = new H264Stream(),
      aacStream = new AacStream();

    // expose the stream metadata
    self.stream = {
      // the mapping between transport stream programs and the PIDs
      // that form their elementary streams
      programMapTable: {}
    };

    // For information on the FLV format, see
    // http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf.
    // Technically, this function returns the header and a metadata FLV tag
    // if duration is greater than zero
    // duration in seconds
    // @return {object} the bytes of the FLV header as a Uint8Array
    self.getFlvHeader = function(duration, audio, video) { // :ByteArray {
      var
        headBytes = new Uint8Array(3 + 1 + 1 + 4),
        head = new DataView(headBytes.buffer),
        metadata,
        result;

      // default arguments
      duration = duration || 0;
      audio = audio === undefined? true : audio;
      video = video === undefined? true : video;

      // signature
      head.setUint8(0, 0x46); // 'F'
      head.setUint8(1, 0x4c); // 'L'
      head.setUint8(2, 0x56); // 'V'

      // version
      head.setUint8(3, 0x01);

      // flags
      head.setUint8(4, (audio ? 0x04 : 0x00) | (video ? 0x01 : 0x00));

      // data offset, should be 9 for FLV v1
      head.setUint32(5, headBytes.byteLength);

      // init the first FLV tag
      if (duration <= 0) {
        // no duration available so just write the first field of the first
        // FLV tag
        result = new Uint8Array(headBytes.byteLength + 4);
        result.set(headBytes);
        result.set([0, 0, 0, 0], headBytes.byteLength);
        return result;
      }

      // write out the duration metadata tag
      metadata = new FlvTag(FlvTag.METADATA_TAG);
      metadata.pts = metadata.dts = 0;
      metadata.writeMetaDataDouble("duration", duration);
      result = new Uint8Array(headBytes.byteLength + metadata.byteLength);
      result.set(head);
      result.set(head.bytesLength, metadata.finalize());

      return result;
    };

    self.flushTags = function() {
      h264Stream.finishFrame();
    };

    /**
     * Returns whether a call to `getNextTag()` will be successful.
     * @return {boolean} whether there is at least one transmuxed FLV
     * tag ready
     */
    self.tagsAvailable = function() { // :int {
      return h264Stream.tags.length + aacStream.tags.length;
    };

    /**
     * Returns the next tag in decoder-timestamp (DTS) order.
     * @returns {object} the next tag to decoded.
     */
    self.getNextTag = function() {
      var tag;

      if (!h264Stream.tags.length) {
        // only audio tags remain
        tag = aacStream.tags.shift();
      } else if (!aacStream.tags.length) {
        // only video tags remain
        tag = h264Stream.tags.shift();
      } else if (aacStream.tags[0].dts < h264Stream.tags[0].dts) {
        // audio should be decoded next
        tag = aacStream.tags.shift();
      } else {
        // video should be decoded next
        tag = h264Stream.tags.shift();
      }

      return tag.finalize();
    };

    self.parseSegmentBinaryData = function(data) { // :ByteArray) {
      var mpegtsStream = new jBinary(data, MPEGTS);
      var packets = mpegtsStream.read('File');
        
      // extracting and concatenating raw stream parts
      stream = new jDataView(mpegtsStream.view.byteLength);

      for (var i = 0, length = packets.length; i < length; i++) {
        var packet = packets[i], adaptation = packet.adaptationField, payload = packet.payload;
        if (payload && payload._rawStream) {
          stream.writeBytes(payload._rawStream);
        }
      }

      var pesStream = new jBinary(stream.slice(0, stream.tell()), PES),
        audioStream = new jBinary(stream.byteLength, ADTS),
        samples = [],
        audioSamples = [];
      
      stream = new jDataView(stream.byteLength);
      //"http://127.0.0.1:9999/video/test.m3u8"

      while (pesStream.tell() < pesStream.view.byteLength) {
        var packet = pesStream.read('PESPacket');
        if (packet.streamId === 0xC0) {
          // 0xC0 means we have got first audio stream
          audioStream.write('blob', packet.data);
        } else
        if (packet.streamId === 0xE0) {
          var nalStream = new jBinary(packet.data, H264),
            curSample = {offset: stream.tell(), pts: packet.pts, dts: packet.dts || packet.pts};
          
          samples.push(curSample);
          
          // collecting info from H.264 NAL units
          while (nalStream.tell() < nalStream.view.byteLength) {
            var nalUnit = nalStream.read('NALUnit');
            switch (nalUnit[0] & 0x1F) {
              case 7:
                if (!sps) {
                  var sps = nalUnit;
                  var spsInfo = new jBinary(sps, H264).read('SPS');
                  var width = (spsInfo.pic_width_in_mbs_minus_1 + 1) * 16;
                  var height = (2 - spsInfo.frame_mbs_only_flag) * (spsInfo.pic_height_in_map_units_minus_1 + 1) * 16;
                  var cropping = spsInfo.frame_cropping;
                  if (cropping) {
                    width -= 2 * (cropping.left + cropping.right);
                    height -= 2 * (cropping.top + cropping.bottom);
                  }
                }
                break;

              case 8:
                if (!pps) {
                  var pps = nalUnit;
                }
                break;

              case 5:
                curSample.isIDR = true;
              /* falls through */
              default:
                stream.writeUint32(nalUnit.length);
                stream.writeBytes(nalUnit);
            }
          }
        }
      }

      samples.push({offset: stream.tell()});

      var sizes = [],
        dtsDiffs = [],
        accessIndexes = [],
        pts_dts_Diffs = [],
        current = samples[0],
        frameRate = {sum: 0, count: 0},
        duration = 0;
      
      // calculating PTS/DTS differences and collecting keyframes
      for (var i = 0, length = samples.length - 1; i < length; i++) {
        var next = samples[i + 1];
        sizes.push(next.offset - current.offset);
        var dtsDiff = next.dts - current.dts;
        if (dtsDiff) {
          dtsDiffs.push({sample_count: 1, sample_delta: dtsDiff});
          duration += dtsDiff;
          frameRate.sum += dtsDiff;
          frameRate.count++;
        } else {
          dtsDiffs.length++;
        }
        if (current.isIDR) {
          accessIndexes.push(i + 1);
        }
        pts_dts_Diffs.push({
          first_chunk: pts_dts_Diffs.length + 1,
          sample_count: 1,
          sample_offset: current.dtsFix = current.pts - current.dts
        });
        current = next;
      }
      
      frameRate = frameRate.sum / frameRate.count;
      
      for (var i = 0, length = dtsDiffs.length; i < length; i++) {
        if (dtsDiffs[i] === undefined) {
          dtsDiffs[i] = {first_chunk: i + 1, sample_count: 1, sample_delta: frameRate};
          duration += frameRate;
          //samples[i + 1].dts = samples[i].dts + frameRate;
        }
      }
      
      // checking if DTS differences are same everywhere to pack them into one item
      var dtsDiffsSame = true;
      
      for (var i = 1, length = dtsDiffs.length; i < length; i++) {
        if (dtsDiffs[i].sample_delta !== dtsDiffs[0].sample_delta) {
          dtsDiffsSame = false;
          break;
        }
      }
      
      if (dtsDiffsSame) {
        dtsDiffs = [{first_chunk: 1, sample_count: sizes.length, sample_delta: dtsDiffs[0].sample_delta}];
      }

      // building audio metadata
      var audioStart = stream.tell(),
        audioSize = audioStream.tell(),
        audioSizes = [],
        audioHeader,
        maxAudioSize = 0;
        
      audioStream.seek(0);
      
      while (audioStream.tell() < audioSize) {
        audioHeader = audioStream.read('ADTSPacket');
        audioSizes.push(audioHeader.data.length);
        if (audioHeader.data.length > maxAudioSize) {
          maxAudioSize = audioHeader.data.length;
        }
        stream.writeBytes(audioHeader.data);
      }

      // generating resulting MP4
      var mp4 = new jBinary(stream.byteLength, MP4);
      
      var trak = [{
        atoms: {
          tkhd: [{
            version: 0,
            flags: 15,
            track_ID: 1,
            duration: duration,
            layer: 0,
            alternate_group: 0,
            volume: 1,
            matrix: {
              a: 1, b: 0, x: 0,
              c: 0, d: 1, y: 0,
              u: 0, v: 0, w: 1
            },
            dimensions: {
              horz: width,
              vert: height
            }
          }],
          mdia: [{
            atoms: {
              mdhd: [{
                version: 0,
                flags: 0,
                timescale: 90000,
                duration: duration,
                lang: 'und'
              }],
              hdlr: [{
                version: 0,
                flags: 0,
                handler_type: 'vide',
                name: 'VideoHandler'
              }],
              minf: [{
                atoms: {
                  vmhd: [{
                    version: 0,
                    flags: 1,
                    graphicsmode: 0,
                    opcolor: {r: 0, g: 0, b: 0}
                  }],
                  dinf: [{
                    atoms: {
                      dref: [{
                        version: 0,
                        flags: 0,
                        entries: [{
                          type: 'url ',
                          version: 0,
                          flags: 1,
                          location: ''
                        }]
                      }]
                    }
                  }],
                  stbl: [{
                    atoms: {
                      stsd: [{
                        version: 0,
                        flags: 0,
                        entries: [{
                          type: 'avc1',
                          data_reference_index: 1,
                          dimensions: {
                            horz: width,
                            vert: height
                          },
                          resolution: {
                            horz: 72,
                            vert: 72
                          },
                          frame_count: 1,
                          compressorname: '',
                          depth: 24,
                          atoms: {
                            avcC: [{
                              version: 1,
                              profileIndication: spsInfo.profile_idc,
                              profileCompatibility: parseInt(spsInfo.constraint_set_flags.join(''), 2),
                              levelIndication: spsInfo.level_idc,
                              lengthSizeMinusOne: 3,
                              seqParamSets: [sps],
                              pictParamSets: [pps]
                            }]
                          }
                        }]
                      }],
                      stts: [{
                        version: 0,
                        flags: 0,
                        entries: dtsDiffs
                      }],
                      stss: [{
                        version: 0,
                        flags: 0,
                        entries: accessIndexes
                      }],
                      ctts: [{
                        version: 0,
                        flags: 0,
                        entries: pts_dts_Diffs
                      }],
                      stsc: [{
                        version: 0,
                        flags: 0,
                        entries: [{
                          first_chunk: 1,
                          samples_per_chunk: sizes.length,
                          sample_description_index: 1
                        }]
                      }],
                      stsz: [{
                        version: 0,
                        flags: 0,
                        sample_size: 0,
                        sample_count: sizes.length,
                        sample_sizes: sizes
                      }],
                      stco: [{
                        version: 0,
                        flags: 0,
                        entries: [0x28]
                      }]
                    }
                  }]
                }
              }]
            }
          }]
        }
      }];

      if (audioSize > 0) {
        trak.push({
          atoms: {
            tkhd: [{
              version: 0,
              flags: 15,
              track_ID: 2,
              duration: duration,
              layer: 0,
              alternate_group: 1,
              volume: 1,
              matrix: {
                a: 1, b: 0, x: 0,
                c: 0, d: 1, y: 0,
                u: 0, v: 0, w: 1
              },
              dimensions: {
                horz: 0,
                vert: 0
              }
            }],
            mdia: [{
              atoms: {
                mdhd: [{
                  version: 0,
                  flags: 0,
                  timescale: 90000,
                  duration: duration,
                  lang: 'eng'
                }],
                hdlr: [{
                  version: 0,
                  flags: 0,
                  handler_type: 'soun',
                  name: 'SoundHandler'
                }],
                minf: [{
                  atoms: {
                    smhd: [{
                      version: 0,
                      flags: 0,
                      balance: 0
                    }],
                    dinf: [{
                      atoms: {
                        dref: [{
                          version: 0,
                          flags: 0,
                          entries: [{
                            type: 'url ',
                            version: 0,
                            flags: 1,
                            location: ''
                          }]
                        }]
                      }
                    }],
                    stbl: [{
                      atoms: {
                        stsd: [{
                          version: 0,
                          flags: 0,
                          entries: [{
                            type: 'mp4a',
                            data_reference_index: 1,
                            channelcount: 2,
                            samplesize: 16,
                            samplerate: 22050,
                            atoms: {
                              esds: [{
                                version: 0,
                                flags: 0,
                                sections: [
                                  {
                                    descriptor_type: 3,
                                    ext_type: 128,
                                    length: 34,
                                    es_id: 2,
                                    stream_priority: 0
                                  },
                                  {
                                    descriptor_type: 4,
                                    ext_type: 128,
                                    length: 20,
                                    type: 'mpeg4_audio',
                                    stream_type: 'audio',
                                    upstream_flag: 0,
                                    buffer_size: 0,
                                    maxBitrate: Math.round(maxAudioSize / (duration / 90000 / audioSizes.length)),
                                    avgBitrate: Math.round((stream.tell() - audioStart) / (duration / 90000))
                                  },
                                  {
                                    descriptor_type: 5,
                                    ext_type: 128,
                                    length: 2,
                                    audio_profile: audioHeader.profileMinusOne + 1,
                                    sampling_freq: audioHeader.samplingFreq,
                                    channelConfig: audioHeader.channelConfig
                                  },
                                  {
                                    descriptor_type: 6,
                                    ext_type: 128,
                                    length: 1,
                                    sl: 2
                                  }
                                ]
                              }]
                            }
                          }]
                        }],
                        stts: [{
                          version: 0,
                          flags: 0,
                          entries: [{
                            sample_count: audioSizes.length,
                            sample_delta: Math.round(duration / audioSizes.length)
                          }]
                        }],
                        stsc: [{
                          version: 0,
                          flags: 0,
                          entries: [{
                            first_chunk: 1,
                            samples_per_chunk: audioSizes.length,
                            sample_description_index: 1
                          }]
                        }],
                        stsz: [{
                          version: 0,
                          flags: 0,
                          sample_size: 0,
                          sample_count: audioSizes.length,
                          sample_sizes: audioSizes
                        }],
                        stco: [{
                          version: 0,
                          flags: 0,
                          entries: [0x28 + audioStart]
                        }]
                      }
                    }]
                  }
                }]
              }
            }]
          }
        });
      };
      
      var creationTime = new Date();

      mp4.write('File', {
        ftyp: [{
          major_brand: 'isom',
          minor_version: 512,
          compatible_brands: ['isom', 'iso2', 'avc1', 'mp41']
        }],
        mdat: [{
          _rawData: stream.getBytes(stream.tell(), 0)
        }],
        moov: [{
          atoms: {
            mvhd: [{
              version: 0,
              flags: 0,
              creation_time: creationTime,
              modification_time: creationTime,
              timescale: 90000,
              duration: duration,
              rate: 1,
              volume: 1,
              matrix: {
                a: 1, b: 0, x: 0,
                c: 0, d: 1, y: 0,
                u: 0, v: 0, w: 1
              },
              next_track_ID: 2
            }],
            trak: trak
          }
        }]
      });
    
      var video = document.createElement('video'), source = document.createElement('source');
      document.body.appendChild(video);
    
    /*
    mp4bytes = mp4.view.getBytes(mp4.view.byteLength, 0);
        function onSourceOpen(videoTag, e) {
          var mediaSource = e.target;
          //var sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.4d401f,mp4a.40.2"');
          var sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="mp4a.40.2"');
          sourceBuffer.appendBuffer(mp4bytes);
          alert('done');
        }

        var mediaSource = new MediaSource();
        mediaSource.addEventListener('sourceopen', onSourceOpen.bind(this, video));
        video.src = window.URL.createObjectURL(mediaSource);
    */

    source.type = 'video/mp4';
    video.appendChild(source);
    video.src = source.src = mp4.toURI('video/mp4');
    video.load();
    video.play();


      return true;
    };

    self.getTags = function() {
      return h264Stream.tags;
    };

    self.getBytes = function() {
      return mp4bytes;
    };

    self.stats = {
      h264Tags: function() {
        return h264Stream.tags.length;
      },
      aacTags: function() {
        return aacStream.tags.length;
      }
    };
  };

  // MPEG2-TS constants
  videojs.Hls.SegmentParser.MP2T_PACKET_LENGTH = MP2T_PACKET_LENGTH = 188;
  videojs.Hls.SegmentParser.STREAM_TYPES = STREAM_TYPES = {
    h264: 0x1b,
    adts: 0x0f
  };

})(window);
