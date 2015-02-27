var app = app || {};
app.models = app.models || {};

// All these globals should be loaded from elsewhere.
assert(! _.isUndefined(getNormalizedCoord),
       'Missing global: getNormalizedCoord');
assert(! _.isUndefined(fillTemplate),
       'Missing global: fillTemplate');
assert(! _.isUndefined(TILE_SIZE),
       'Missing global: TILE_SIZE');
assert(! _.isUndefined(MIN_ZOOM_OFFSET),
       'Missing global: MIN_ZOOM_OFFSET');

$(function($) {
    app.models.Overlay = Backbone.Model.extend({
        idAttribute: 'key', // Backend uses "key" as the primary key

        initialize: function() {
            // Bind all the model's function properties to the instance,
            // so they can be passed around as event handlers and such.
            _.bindAll(this);
            this.on('before_warp', this.beforeWarp);
            this.on('change:exportUrl', function() {
                if (this.exportPending && this.get('exportUrl')) {
                    console.log('Export trigger.');
                }
            }, this);
            this.on('export_ready', function() {
                console.log('Export Ready!');
            });
        },

        url: function() {
            var pk = (_.isUndefined(this.get('id')) ?
                      this.get('key') : this.get('id'));
            return this.get('url') || '/overlay/' + pk + '.json';
        },

        getImageTileUrl: function(coord, zoom) {
            assert(this.get('unalignedTilesUrl'),
                   'Overlay is missing an unalignedTilesUrl property.' +
                   ' Likely it does not have an unalignedQuadTree set' +
                   ' on the backend.');
            var normalizedCoord = getNormalizedCoord(coord, zoom);
            if (!normalizedCoord) { return null; }
            var url = fillTemplate(this.get('unalignedTilesUrl'), {
                zoom: zoom,
                x: normalizedCoord.x,
                y: normalizedCoord.y
            });
            return url;
        },

        parse: function(resp, xhr) {
            // Ensure server-side state never overwrites local points value
            if (this.has('points') && 'points' in resp) {
                delete resp.points;
            }
            return resp;
        },

        getAlignedImageTileUrl: function(coord, zoom) {
            var normalizedCoord = getNormalizedCoord(coord, zoom);
            if (!normalizedCoord) {return null;}
            return fillTemplate(this.get('alignedTilesUrl'),
                {zoom: zoom,
                 x: normalizedCoord.x,
                 y: normalizedCoord.y});
        },

        maxDimension: function() {
            var size = this.get('imageSize');
            if (_.isUndefined(size)) {
                throw "Overlay image's size is not defined or not yet loaded.";
            }
            return Math.max(size[0], size[1]);
        },

        maxZoom: function() {
            var mz = (Math.ceil(Math.log(this.maxDimension() / TILE_SIZE) /
                                Math.log(2)) +
                      MIN_ZOOM_OFFSET);
            return mz;
        },

        imageBounds: function() {
            var imageSize = this.get('imageSize');
            var w = imageSize[0];
            var h = imageSize[1];
            var sw = pixelsToLatLon({x: 0, y: 0}, this.maxZoom());
            var ne = pixelsToLatLon({x: w, y: h}, this.maxZoom());
            var bounds = new google.maps.LatLngBounds(sw, ne);
            return bounds;
        },

        mapBounds: function() {
            var bounds = this.get('bounds');
            return new google.maps.LatLngBounds(
                new google.maps.LatLng(bounds.south, bounds.west),
                new google.maps.LatLng(bounds.north, bounds.east)
            );
        },

        /**
         * Update one "side" (map or image) of an entry in the model's
         * tiepoint array.  Will add a new tiepoint if one doesn't
         * already exist at that index.
        */
        updateTiepoint: function(whichSide, pointIndex, coords, drawMarkerFlag) {
        	//drawMarkerFlag is set to true unless function is called with 'false' as an arg.
        	drawMarkerFlag = typeof drawMarkerFlag !== 'undefined' ? drawMarkerFlag : true;
            var points = this.get('points');
            var initial_length = points.length;
            var tiepoint = points[pointIndex] || [null, null, null, null];
            var coordIdx = {
                'map': [0, 1],
                'image': [2, 3]
            }[whichSide];
            assert(coordIdx, 'Unexpected whichSide argument: ' + whichSide);
            tiepoint[coordIdx[0]] = coords.x;
            tiepoint[coordIdx[1]] = coords.y;
            points[pointIndex] = tiepoint;
            this.set('points', points);
            if (points.length > initial_length) this.trigger('add_point');
            // Manually trigger this, because the value of model.points
            // (an array reference) hasn't actually changed.
            if (drawMarkerFlag) {
            	this.trigger('change:points');
            }
        },

        deleteTiepoint: function(index) {
            actionPerformed();

            points = this.get('points');
            points.splice(index, 1);
            this.set('points', points);
            this.trigger('change:points');
        },

        computeTransform: function() {
            // only operate on points that have all four values.
            var points = _.filter(this.get('points'), function(coords) {
                return _.all(coords, _.identity);
            });
            // a minimum of two tiepoints are required to compute the transform
            if (points.length < 2) return false;
            // issMRF will be undefined for all other transforms besides CameraModelFrame
            var issMRF = this.get('issMRF'); 
            // set the 'transform' field of the overlay model with the newly computed tform.
            this.set('transform',
                (points ?
                 geocamTiePoint.transform.getTransform(points, issMRF).toDict() :
                 {type: '', matrix: []})
            );
        },

        save: function(attributes, options) {
            // Always compute transform on before save.
            this.computeTransform();
            return Backbone.Model.prototype.save.call(this, attributes,
                                                      options);
        },

        beforeWarp: function() {
            // We have to clear this because this.fetch() won't.
            this.unset('exportUrl');
        },

        warp: function(options) {
            // Save the overlay, which triggers a server-side warp.
            options = options || {};
            var model = this;
            model.trigger('before_warp');
            saveOptions = {
                error: function(model, response) {
                    if (response.readyState < 4) {
                        model.trigger('warp_server_unreachable');
                    } else {
                        model.trigger('warp_server_error');
                    }
                    if (options.error) options.error();
                },
                success: function(model, response) {
                    if (options.success) options.success();
                    model.trigger('warp_success');
                }
            };
            this.save({}, saveOptions);
        },

        startExport: function(options) {
            //this.unset('exportUrl');
            assert(! this.get('exportUrl'), 'Model has an exportUrl already.');
            var request_url = this.get('url').replace('.json',
                                                      '/generateExport/');
            this.exportPending = true;
            var model = this;
            model.on('export_ready', function() {this.exportPending = false;},
                     this);
            $.post(request_url, '', function() {
                model.fetch({ success: function() {
                    /* on app engine our request to generate an export
                       gets an immediate response from the server
                       because the actual work is done in the background
                       on a backend instance. thus we'll ignore the
                       server response and detect completion by polling
                       the meta-data url until we see an exportUrl field
                       appear.
                    */
                } });
            }, 'json')
            .error(function(xhr, status, error) {
                 this.exportPending = false;
                 if (options.error) options.error();
            });
            this.pollUntilExportComplete(model);
        },

        pollUntilExportComplete: function pollForExportComplete(model,
                                                                timeout) {
            if (!model.exportPending) return false;
            this.fetch();
            if (this.get('exportUrl')) {
                model.trigger('export_ready');
                return false;
            }
            // exponential backoff on polling
            var timeout = timeout ? 1.5 * timeout : 1000;
            console.log('polling overlay: ' + timeout);
            this.pollTimer = setTimeout(_.bind(pollForExportComplete, this),
                                        timeout, model, timeout);
        }

    });

    app.OverlayCollection = Backbone.Collection.extend({
        model: app.models.Overlay,
        url: '/overlays.json',
        comparator: function(overlay) {
            // Sort by modified time, descending
            return -1 * Date.parse(overlay.get('lastModifiedTime'));
        }
    });

    app.overlays = new app.OverlayCollection();
});
