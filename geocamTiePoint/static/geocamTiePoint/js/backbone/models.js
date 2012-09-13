var app = app || {};
app.models = app.models || {};

// All these globals should be loaded from elsewhere.
assert( ! _.isUndefined(getNormalizedCoord), "Missing global: getNormalizedCoord");
assert( ! _.isUndefined(getNormalizedCoord), "Missing global: fillTemplate");
assert( ! _.isUndefined(TILE_SIZE), "Missing global: TILE_SIZE");
assert( ! _.isUndefined(MIN_ZOOM_OFFSET), "Missing global: MIN_ZOOM_OFFSET");

$( function($) {
    app.models.Overlay = Backbone.Model.extend({
        idAttribute: 'key', // Backend uses "key" as the primary key
        url: function(){ return this.get('url') || '/overlay/'+this.id+'.json' },

        initialize: function(){
            var model = this;
            this.getImageTileUrl = function(coord, zoom) {
                var normalizedCoord = getNormalizedCoord(coord, zoom);
                if (!normalizedCoord) { return null; }
                var url = fillTemplate(model.get('unalignedTilesUrl'), {
                    zoom: zoom,
                    x: normalizedCoord.x,
                    y: normalizedCoord.y,
                });
                return url;
            };

            window.maxZoom0G = this.maxZoom();
        },

        maxDimension: function(){
            var size = this.get('imageSize');
            return Math.max(size[0], size[1]);
        },

        maxZoom: function() {
            var mz = Math.ceil( Math.log(this.maxDimension() / TILE_SIZE) / Math.log(2) ) + MIN_ZOOM_OFFSET;
            return mz;
        },

        imageBounds: function() {
            var imageSize = this.get('imageSize');
            var sw = pixelsToLatLon({x:0, y: imageSize[1]}, this.maxZoom());
            var ne = pixelsToLatLon({x:imageSize[0], y: 0}, this.maxZoom());
            var bounds = new google.maps.LatLngBounds(sw, ne);
            return bounds;
        },

        mapBounds: function() {
            var bounds = this.get('bounds');
            return new google.maps.LatLngBounds(
                new google.maps.LatLng( bounds.south, bounds.west ),
                new google.maps.LatLng( bounds.north, bounds.east )
            );
        },

    });

    app.OverlayCollection = Backbone.Collection.extend({
        model: app.models.Overlay,
        url: '/overlays.json',
    });

    app.overlays = new app.OverlayCollection();
});