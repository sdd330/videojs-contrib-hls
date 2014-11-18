(function(window){
  var urlCount = 0,
      EventEmitter,
      objectUrlPrefix = 'blob:vjs-media-source/',
      createVideo,
      nextFrame,
      playerVideoObj,
      currentVideo,
      videos = [],
      nextIndex = 0,
      canvas,
      context,

      /**
       * Polyfill for requestAnimationFrame
       * @param callback {function} the function to run at the next frame
       * @see https://developer.mozilla.org/en-US/docs/Web/API/window.requestAnimationFrame
       */
      requestAnimationFrame = function(callback) {
        return (window.requestAnimationFrame ||
                window.webkitRequestAnimationFrame ||
                window.mozRequestAnimationFrame ||
                function(callback) {
                  return window.setTimeout(callback, 1000 / 60);
                })(callback);
      };

  nextFrame = function() {
    //if (currentVideo.paused || currentVideo.ended) {
    //  return;
    //}
    context.drawImage(currentVideo, 0, 0);
    requestAnimationFrame(nextFrame);
  };

  createVideo = function(index, url){
    var video;
    if(index === 0){
      video = playerVideoObj;
      currentVideo = playerVideoObj;
      nextIndex++;
    } else {
      video = document.createElement('video');
    }

    video.addEventListener('play', function () {
      if (currentVideo !== this) {
        currentVideo = this;
        nextIndex++;
      }

      nextFrame();
    });

    video.addEventListener('ended', function () {
      delete videos[nextIndex - 1];
      if (nextIndex in videos) {
        videos[nextIndex].play();
      }
      URL.revokeObjectURL(this.src);
    });

    video.src = url;
    video.load();
    videos[index] = video;
    nextFrame();
  };

  EventEmitter = function(){};
  EventEmitter.prototype.init = function(){
    this.listeners = [];
  };
  EventEmitter.prototype.addEventListener = function(type, listener){
    if (!this.listeners[type]){
      this.listeners[type] = [];
    }
    this.listeners[type].unshift(listener);
  };
  EventEmitter.prototype.removeEventListener = function(type, listener){
    var listeners = this.listeners[type],
        i = listeners.length;
    while (i--) {
      if (listeners[i] === listener) {
        return listeners.splice(i, 1);
      }
    }
  };
  EventEmitter.prototype.trigger = function(event){
    var listeners = this.listeners[event.type] || [],
        i = listeners.length;
    while (i--) {
      listeners[i](event);
    }
  };

  // extend the media source APIs

  // Media Source
  videojs.MediaSource = function(){
    var self = this;
    videojs.MediaSource.prototype.init.call(this);
    this.segmentParser = new videojs.Hls.SegmentParser();
    this.sourceBuffers = [];
    this.readyState = 'closed';
    this.listeners = {
      sourceopen: [function(event){
        playerVideoObj = document.getElementById(event.playerId);
        playerVideoObj.style.visibility = 'hidden';
        var container = playerVideoObj.parentNode;
        canvas = document.createElement("canvas");
        canvas.width = playerVideoObj.width;
        canvas.height = playerVideoObj.height;
        context = canvas.getContext("2d");
        container.appendChild(canvas);
        self.readyState = 'open';
      }],
      webkitsourceopen: [function(event){
        self.trigger({
          type: 'sourceopen'
        });
      }]
    };
  };

  videojs.MediaSource.prototype = new EventEmitter();
  videojs.MediaSource.prototype.addSourceBuffer = function(type){
    var sourceBuffer = new videojs.SourceBuffer(this);
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  };

  videojs.MediaSource.prototype.endOfStream = function(){
    this.readyState = 'ended';
  };

  videojs.mediaSources = {};
  videojs.MediaSource.open = function(msObjectURL, playerId){
    var mediaSource = videojs.mediaSources[msObjectURL];

    if (mediaSource) {
      mediaSource.trigger({
        type: 'sourceopen',
        playerId: playerId
      });
    } else {
      throw new Error('Media Source not found (Video.js)');
    }
  };

  // Source Buffer
  videojs.SourceBuffer = function(source){
    var self = this,
        buffer = [],
        bufferSize = 0,
        mediaIndex = 0,
        segmentParser = source.segmentParser;
        append = function() {
          var chunk, i, length, payload,
              binary = '';

          if (!buffer.length) {
            // do nothing if the buffer is empty
            return;
          }

          // concatenate appends up to the max append size
          payload = buffer.shift();
          bufferSize -= payload.byteLength;

          // schedule another append if necessary
          if (bufferSize !== 0) {
            requestAnimationFrame(append);
          } else {
            segmentParser.parseSegmentBinaryData(mediaIndex, payload, function(data){
              createVideo(data.mediaIndex, data.url);
              self.trigger({ type: 'updateend' });
            });
            mediaIndex++;
          }
        };


    videojs.SourceBuffer.prototype.init.call(this);
    this.source = source;

    this.appendBuffer = function(uint8Array){
      if (buffer.length === 0) {
        requestAnimationFrame(append);
      }
      this.trigger({ type: 'update' });
      buffer.push(uint8Array);
      bufferSize += uint8Array.byteLength;
    };

    this.abort = function() {
      buffer = [];
      bufferSize = 0;
    };
  };

  videojs.SourceBuffer.prototype = new EventEmitter();

  // URL
  videojs.URL = {
    createObjectURL: function(object){
      var url = objectUrlPrefix + urlCount;    
      urlCount++;
      videojs.mediaSources[url] = object;
      return url;
    }
  };

})(this);
