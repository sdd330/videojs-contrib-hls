'use strict';

importScripts('../libs/require.js');

require.config({
	paths: {
		jdataview: '../libs/jdataview',
		jbinary: '../libs/jbinary'
	}
});

require(['jbinary', '../libs/mpegts_to_mp4/mpegts', '../libs/mpegts_to_mp4/index'],
	function (jBinary, MPEGTS, mpegts_to_mp4) {
        var eventList = [];
        var processing = false;

        function processEvent(){
            if(!processing && eventList.length > 0){
                processing = true;
                var event = eventList.shift();
                var mediaData = event.data.mediaData;
                var mediaIndex = event.data.mediaIndex;
                var mpegts = new jBinary(mediaData, MPEGTS);
                var mp4 = mpegts_to_mp4(mpegts);
                postMessage({
                    type: 'video',
                    mediaIndex: mediaIndex,
                    url: mp4.toURI('video/mp4')
                });
                processing = false;
            }
        }

		addEventListener('message', function (event) {
            eventList.push(event);
            processEvent();
		});

		postMessage({type: 'ready'});
	}
);


    /* MediaSource addSourceBuffer does not work
        var video = document.createElement('video');
        document.body.appendChild(video);
        mp4bytes = mp4bin.view.getBytes(mp4.view.byteLength, 0);
        function onSourceOpen(videoTag, e) {
          var mediaSource = e.target;
          var sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.4d401f,mp4a.40.2"');
          sourceBuffer.appendBuffer(mp4bytes);
        }

        var mediaSource = new MediaSource();
        mediaSource.addEventListener('sourceopen', onSourceOpen.bind(this, video));
        video.src = window.URL.createObjectURL(mediaSource);
    */

    /* Using source works
        var video = document.createElement('video'), source = document.createElement('source');
        document.body.appendChild(video);
        source.type = 'video/mp4';
        video.appendChild(source);
        video.src = source.src = mp4bin.toURI('video/mp4');
        video.load();
        video.play();
    */