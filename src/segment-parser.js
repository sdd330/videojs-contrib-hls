(function(window) {
  var videojs = window.videojs;
  var callbacks = [];
  var worker = new Worker('./src/worker.js');
  worker.addEventListener('message', function (event) {
    if(event.data.type === "video"){
      var callback = callbacks[event.data.mediaIndex];
      if(callback){
        callback(event.data);
      }
    }
    return;
  });

  /**
   * An object that incrementally transmuxes MPEG2 Trasport Stream
   * chunks into an FLV.
   */
  videojs.Hls.SegmentParser = function() {
    var self = this;
    
    self.parseSegmentBinaryData = function(mediaIndex, data, callback) { // :ByteArray) {
      callbacks[mediaIndex] = callback;
      worker.postMessage({mediaIndex: mediaIndex, mediaData: data});
      return true;
    };
  };

})(window);
