(function(window) {
  var videojs = window.videojs;
  /**
   * An object that incrementally transmuxes MPEG2 Trasport Stream
   * chunks into an FLV.
   */
  videojs.Hls.SegmentParser = function() {
    var self = this;
    
    self.parseSegmentBinaryData = function(data, callback) { // :ByteArray) {
      var worker = new Worker('./src/worker.js');
      worker.addEventListener('message', function (event) {
        if(event.data.type === "ready"){
          worker.postMessage(data);
        } else if(event.data.type === "video"){
          callback(event.data.url);
        }
        return;
      });

      return true;
    };
  };

})(window);
