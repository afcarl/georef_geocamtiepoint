assert(!_.isUndefined(window.actionPerformed),
		'Missing global actionPerformed().  Check for undo.js');
app.views = {};
app.map = app.map || {}; // namespace for map helper stuff
var centerPointMarker = null;

vent = _.extend({}, Backbone.Events);

// modes
mode = {
	NAVIGATE : 0,
	ADD_TIEPOINTS : 1,
	DELETE_TIEPOINTS : 2
}

$(function($) {

	app.mode = mode.NAVIGATE;

	app.container_id = '#backbone_app_container';

	/*
	 * Handlebars helper that allows us to access model instance attributes from
	 * within a template. attr must be passed in as a (quoted) string literal
	 * from the template.
	 */
	Handlebars.registerHelper('get', function(attr) {
		return this.get(attr);
	});
	Handlebars.registerHelper('nospecials', function(s) {
		return s.replace(/[^\w]/g, '_');
	});

	app.views.View = Backbone.View.extend({
		// views will render here unless another element is specified on
		// instantiation.
		el : app.container_id,
		template : null,
		context : null,
		beforeRender : function() {
		}, // optional hook
		afterRender : function() {
		}, // optional hook
		render : function() {
			this.beforeRender();
			if (!this._renderedTemplate && this.template != null) {
				this._renderedTemplate = Handlebars.compile(this.template);
			}
			if (!this.context && !this.model) {
				this.context = {};
			}
			var context;
			if (this.context) {
				context = (_.isFunction(this.context) ? this.context()
						: this.context);
			} else {
				context = this.model.attributes;
			}
			if ((this._renderedTemplate != null)
					&& (this._renderedTemplate != undefined)) {
				var output = this._renderedTemplate(context);
				this.$el.html(output);
			}
			this.afterRender();
			if (this.el === $(app.container_id)[0]) {
				app.currentView = this;
			}
			return this;
		}
	});

	app.views.NavbarView = app.views.View.extend({
		template : '<div class="navbar-inner">'
				+ '<ul id="navlist" class="nav">' + '<li><a href="/">'
				+ '<img src="/static/georef/icons/GeoRefNoBox.png"/>'
				+ '</a></li>' + '<li class="nav_pad_vertical navbar-text">'
				+ '<a href="/">Overview</a></li>'
				+ '<li class="nav_pad_vertical navbar-text">'
				+ '<a href="#overlays/">List Overlays</a></li>' + '</ul>'
				+ '<p class="pull-right navbar-text" style="float:right">'
				+ '<a href="/accounts/logout/">Logout</a></p>' + '</div>'
	});

	app.views.ListOverlaysView = app.views.View.extend({
		template : $('#template-list-overlays').html(),
		initialize : function() {
			app.views.View.prototype.initialize.apply(this, arguments);
			this.context = {
				overlays : app.overlays
			};
			app.overlays.on('remove', function() {
				this.render();
			}, this);
		},
		deleteOverlay : function(overlay_id) {
			var dialog = this.$('#confirmDelete');
			function deleteSpecificOverlay() {
				dialog.modal('hide');
				app.overlays.get(overlay_id).destroy();
			}
			dialog.on('click', '#deleteYesBtn', deleteSpecificOverlay);
			dialog.on('hidden', function() {
				dialog.off('click', '#deleteYesBtn', deleteSpecificOverlay);
				return true;
			});
			dialog.modal('show');
		}
	});

	app.views.HomeView = app.views.ListOverlaysView;

	/*
	 * OverlayView: id-accepting base class for views that deal with a single
	 * Overlay. Base class for both OverlayGoogleMapsView and SplitOverlayView
	 */
	app.views.OverlayView = app.views.View.extend({
		initialize : function(options) {
			app.views.View.prototype.initialize.apply(this, arguments);
			if (this.id && !this.model) {
				this.model = app.overlays.get(this.id);
			}
			assert(this.model, 'Requires an Overlay model!');
		},

		getState : function() {
			return this.model.attributes; // .toJSON();
		},

		setState : function(state) {
			return this.model.set(state);
		},

		addOrUpdateTiepoint : function(key, value) {
			var foundPoint = this.model.getFirstIncompleteTiepoint(key);
			if (foundPoint != null) {
				foundPoint.set(key, value);
				this.renderPoint(foundPoint);
			} else {
				var newPoint = new app.models.TiePoint();
				newPoint.set(key, value);
				var tiepoints = this.model.get('points');
				tiepoints.add(newPoint);
			}
		}
	});

	app.views.TiepointView = app.views.View.extend({
		initialize : function(options) {
			app.views.View.prototype.initialize.apply(this, arguments);
			this.processOptions(options);
			this.model.on('destroy', this.destroy, this);
			this.model.collection.on('remove', this.handleNumberChange, this);
			this.render();
		},
		handleNumberChange : function() {
			var index = this.getIndex();
			if (index >= 0) {
				this.setNumberText(index);
			}
		},
		handleClick : function() {
			if (app.mode == mode.DELETE_TIEPOINTS) {
				if (this.model != undefined) {
					actionPerformed();
					// this.hide();
					// this.stopListening();
					// this.model.collection.off('remove',
					// this.handleNumberChange, this);
					this.model.destroy();
					// this.model = undefined;
					// this.hide();
				}
			}
		},
		destroy : function() {
			this.undelegateEvents();
			this.hide();
			this.stopListening();
		},
		stopListening : function() {
			if (this.model.collection != undefined) {
				this.model.collection.off('remove', this.handleNumberChange,
						this);
			}
			app.views.View.prototype.stopListening.apply(this, arguments);
		},
		getIndex : function() {
			var result = -1;
			if (!_.isUndefined(this.model.collection)) {
				result = this.model.collection.indexOf(this.model);
				if (result >= 0) {
					return result + 1;
				}
			}
			return result;
		}
	});

	
	
	// Handle rendering, moving and deleting the tie point in the image view.
	app.views.ImageTiePointView = app.views.TiepointView.extend({
		processOptions : function(options) {
			this.viewer = options.viewer;
		},
		render : function() {
			var context = this;
			this.marker_id = this.model.cid + "_imgmarker";
			this.img = document.createElement('img');
			this.img.id = this.marker_id;
			this.img.src = "/static/geocamTiePoint/images/marker.png";
//			this.img.onclick = function() {
//				context.handleClick()
//			};
			var text_id = this.model.cid + "_text";
			this.numberText = document.createElement('span');
			this.numberText.id = text_id;
			this.setNumberText(this.getIndex());
			this.numberText.setAttribute('class', 'tiepoint_number');
//			this.numberText.onclick = function() {
//				context.handleClick()
//			};
			var osdPoint = new OpenSeadragon.Point(this.model
					.get('imageCoords')[0], this.model.get('imageCoords')[1]);
			var viewportPoint = this.viewer.viewport
					.imageToViewportCoordinates(osdPoint);
			this.viewer.addOverlay({
				element : this.img,
				location : viewportPoint,
				rotationMode : OpenSeadragon.OverlayRotationMode.NO_ROTATION,
				placement : OpenSeadragon.Placement.BOTTOM
			});
			this.markerOverlay = this.viewer.getOverlayById(this.marker_id);
			this.viewer.addOverlay({
				element : this.numberText,
				location : viewportPoint,
				rotationMode : OpenSeadragon.OverlayRotationMode.NO_ROTATION,
				placement : OpenSeadragon.Placement.TOP
			});
			this.textOverlay = this.viewer.getOverlayById(text_id);
			
			this.hookDragDrop();
		},
		hookDragDrop: function() {
			var context = this;
			 this.tracker= new OpenSeadragon.MouseTracker({
		            element: this.marker_id,
		            clickTimeThreshold: 200,
		            clickDistThreshold: 1,
		            stopDelay: 50,
		        })
		        this.viewer.addViewerInputHook({hooks: [
		          {tracker: this.tracker, handler: 'dragHandler',   hookHandler: function(event) { context.onHookTaskDrag(event)}},
		          {tracker: this.tracker, handler: 'dragEndHandler',   hookHandler: function(event) {context.onHookTaskDragEnd(event)}},
		          {tracker: this.tracker, handler: 'clickHandler',   hookHandler: function(event) { context.handleClick(event)}}
		        ]});

		},
		
		onHookTaskDrag: function(event){
			//TODO there is a big rubberbanding slowdown effect maybe this needs a delay
		     var viewportPoint = this.viewer.viewport.pointFromPixel(event.position); 
//		     var imagePoint = this.viewer.viewport.viewportToImageCoordinates(viewportPoint);
		     var windowCoords = this.viewer.viewport.viewportToWindowCoordinates(viewportPoint);
		     console.log(this.img.style.left + " " + this.img.style.top);
//		     this.markerOverlay.adjust(viewportPoint, this.markerOverlay.size);
//		     this.markerOverlay.update(viewportPoint, OpenSeadragon.Placement.BOTTOM);
		     
		     $(this.img).css({'top': windowCoords.y,
		    	 			  'left': windowCoords.x});
		     console.log(this.img.style.left + " " + this.img.style.top);

		     $(this.numberText).css({'top': windowCoords.y + 25,
	 			  					 'left': windowCoords.x + 8});

		},
		onHookTaskDragEnd: function(event){
			 var viewportPoint = this.viewer.viewport.pointFromPixel(event.position);
			 console.log(this.markerOverlay.location);
			 this.markerOverlay.update(viewportPoint, OpenSeadragon.Placement.BOTTOM);
			 console.log('after');
			 console.log(this.markerOverlay.location);
			 this.updateTiepointFromMarker(viewportPoint);
		},
		updateTiepointFromMarker : function(viewportPoint) {
			// TODO somehow these positions are all just wrong wrong wrong
			actionPerformed();
			var viewportPoint = this.markerOverlay.location;
			var imagePoint = this.viewer.viewport.viewportToImageCoordinates(viewportPoint);
			console.log('imagepoint');
			console.log(imagePoint);
			this.model.set('imageCoords', imagePoint);
		},
		setNumberText : function(value) {
			this.numberText.innerHTML = value;
		},
		hide : function() {
//			if (!_.isUndefined(this.markerOverlay)) {
				this.viewer.removeOverlay(this.markerOverlay);
				this.viewer.removeOverlay(this.textOverlay);
				this.markerOverlay.destroy();
				this.textOverlay.destroy();
				this.numberText.remove();
				this.img.remove();
//				this.markerOverlay = undefined;
//				this.textOverlay = undefined;
//			}
		}
	});

	// Handle rendering, moving and deleting the tie point in the map view.
	app.views.GoogleMapTiePointView = app.views.TiepointView.extend({
		processOptions : function(options) {
			this.gmap = options.gmap;
		},
		render : function() {
			this.marker = maputils.createLabeledMarker(
					metersToLatLon(this.model.get('mapCoords')), this
							.getIndex(), this.gmap);
			this.marker_id = this.marker.label.span.id;
			this.initMarkerDragHandlers();
		},
		initMarkerDragHandlers : function() {
			var context = this;
			google.maps.event.addListener(this.marker, 'dragstart', function(
					evt) {
				if (app.mode == mode.ADD_TIEPOINTS) {
					window.draggingG = true;
					context.trigger('dragstart');
				}
			});
			google.maps.event.addListener(this.marker, 'dragend', _
					.bind(function(event) {
						if (app.mode == mode.ADD_TIEPOINTS) {
							actionPerformed();
							context.updateTiepointFromMarker();
						}
						_.delay(function() {
							window.draggingG = false;
						}, 200);
					}));

			this.marker.addListener('click', function(event) {
				if (app.mode == mode.DELETE_TIEPOINTS) {
					context.handleClick();
				}
			});
		},
		updateTiepointFromMarker : function() {
			this.model.set('mapCoords', latLonToMeters(this.marker
					.getPosition()));
		},
		handleSelect : function() {
			this.marker.set('selected', true);
			// this.initMarkerDragHandlers();
		},
		handleNumberChange : function() {
			var index = this.getIndex();
			if (index >= 0) {
				this.marker.label.span.innerHTML = index;
			}
		},
		hide : function() {
			if (!_.isUndefined(this.marker)) {
				$("#" + this.marker_id).remove();
				this.marker.setMap(null);
			}
		}
	});

	/*
	 * OverlayGoogleMapsView: Base class for ImageQtreeView and MapView
	 * Implements Google Maps and Marker initialization & management
	 */
	app.views.OverlayGoogleMapsView = app.views.OverlayView.extend({
		initialize : function(options) {
			app.views.OverlayView.prototype.initialize.apply(this, arguments);
			this.options = options;
			this.on('gmap_loaded', this.initGmapUIHandlers);
			// this.model.on('change:points', this.drawMarkers, this);
		},

		// updateTiepointFromMarker: function(index, marker) {
		// assert(false, 'Override me in a subclass!');
		// },

		// _drawMarkers: function(latlons_in_gmap_space) {
		// var model = this.model;
		// var gmap = this.gmap;
		// var selected_idx;
		// // destroy existing markers, if they exist.
		// while (this.markers && this.markers.length > 0) {
		// var marker = this.markers.pop();
		// if (marker.get('selected')) selected_idx = this.markers.length;
		// // get the id of the marker
		// var markerId = marker.label.span.id;
		// markerId = "#" + markerId;
		// // remove the marker label
		// $(markerId).remove();
		// marker.setMap(null);
		// }
		// var markers = this.markers = [];
		// _.each(latlons_in_gmap_space, function(latLon, index) {
		// if (! _.any(_.values(latLon), _.isNull)) {
		// var marker = (maputils.createLabeledMarker(latLon,
		// '' + (index + 1),
		// gmap));
		// if (index === selected_idx) marker.set('selected', true);
		// this.initMarkerDragHandlers(marker);
		// markers[index] = marker;
		// }
		// }, this);
		// model.trigger('redraw_markers');
		// },

		// drawMarkers: function() {
		// assert(false, 'Override me in a subclass!');
		// },

		// selectMarker: function(idx) {
		// _.each(this.markers, function(marker, i) {
		// marker.set('selected', i === idx);
		// });
		// app.currentView.trigger('change_selection');
		// },

		// getSelectedMarkerIndex: function() {
		// var selected_idx = -1;
		// _.each(this.markers, function(marker, i) {
		// if (marker.get('selected')) {
		// selected_idx = i;
		// return true;
		// }
		// });
		// return selected_idx;
		// },

		handleClick : function(event) {
			if (app.mode == mode.ADD_TIEPOINTS) {
				if (!_.isUndefined(window.draggingG) && draggingG) {
					return;
				}
				actionPerformed();
				this.addOrUpdateTiepoint('mapCoords',
						latLonToMeters(event.latLng));
			}
		},

		initGmapUIHandlers : function() {
			if (!this.options.readonly) {
				google.maps.event.addListener(this.gmap, 'click', _.bind(
						this.handleClick, this));
			}
		}

	// initMarkerDragHandlers: function(marker) {
	// var view = this;
	// (google.maps.event.addListener
	// (marker, 'dragstart', function(evt) {
	// window.draggingG = true;
	// view.trigger('dragstart');
	// }));
	// (google.maps.event.addListener
	// (marker, 'dragend',
	// _.bind(function(event) {
	// actionPerformed();
	// var index = this.markers.indexOf(marker);
	// assert(index >= 0, 'Marker not found.');
	// this.updateTiepointFromMarker(index, marker, false);
	// _.delay(function() {window.draggingG = false;}, 200);
	// }, this)));
	// }

	}); // end OverlayGoogleMapsView base class

	app.views.MapView = app.views.OverlayGoogleMapsView
			.extend({
				template : '<div id="map_canvas"></div>',
				overlay_enabled : true,

				initialize : function(options) {
					app.views.OverlayGoogleMapsView.prototype.initialize.apply(
							this, arguments);
					if (this.id && !this.model) {
						this.model = app.overlays.get(this.id);
					}
					assert(this.model, 'Requires a model!');
					this.model.on('add:points', function(point) {
						this.renderPoint(point)
					}, this);
//					this.model.on('change:points',
//							this.destroyAlignedImageQtree, this);
//					this.model.on('add:points', this.destroyAlignedImageQtree,
//							this);
//					this.model.on('remove:points',
//							this.destroyAlignedImageQtree, this);
//					this.model.on('warp_success',
//							this.refreshAlignedImageQtree, this);
//					this.on('dragstart', this.destroyAlignedImageQtree, this);
				},
				renderPoint : function(point) {
					if (!_.isEmpty(point.get('mapCoords'))) {
						new app.views.GoogleMapTiePointView({
							model : point,
							gmap : this.gmap
						});
					}
				},

				afterRender : function() {
					assert(!_.isUndefined(fitNamedBounds),
							'Missing global function: fitNamedBounds');
					assert(!_.isUndefined(maputils.handleNoGeolocation),
							'Missing global function: handleNoGeolocation');

					var mapOptions = {
						zoom : 6,
						mapTypeId : google.maps.MapTypeId.ROADMAP,
						draggableCursor : 'crosshair'
					};

					this.gmap = new google.maps.Map(this.$('#map_canvas')[0],
							mapOptions);

					// disable 45-degree imagery
					this.gmap.setTilt(0);

					if (this.model.get('bounds')) {
						fitNamedBounds(this.model.get('bounds'), this.gmap);
					} else {
						try {
							this.panMapToCenterPoint();
						} catch (err) {
							console
									.log("Error while panning the map to center point");
							maputils.handleNoGeolocation(this.gmap, false);
						}
					}

					this.drawMarkers();

					this.trigger('gmap_loaded');

					/* Events and init for the qtree overlay */
					// this.model.on('change:points', function() {
					// // if (_.isUndefined(this.previousPoints) ||
					// // ! _.isEqual(this.previousPoints,
					// // this.model.get('points'))) {
					// // // Serialize and deserialize to create a deep copy.
					// // this.previousPoints = (JSON.parse
					// // (JSON.stringify
					// // (this.model.get('points'))));
					// this.destroyAlignedImageQtree();
					// // if (this.model.get('points').length > 2)
					// this.model.warp();
					// }
					// }, this);
					if (this.model.get('transform')
							&& this.model.get('transform').type) {
						this.initAlignedImageQtree();
					}
					this.showCurrentInfo();
				},

				initAlignedImageQtree : function() {
					var DEFAULT_OPACITY = 40;
					var overlayEnabled = this.overlay_enabled;
					var alignedImageVisible = this.alignedImageVisible;
					if (this.overlay_enabled && !this.alignedImageVisible) {
						this.alignedImageVisible = true;
						var mapType = new maputils.AlignedImageMapType(this.model);
						this.gmap.overlayMapTypes.insertAt(0, mapType);
						if (_.isUndefined(this.model.overlayOpacity)) {
							this.model.overlayOpacity = DEFAULT_OPACITY;
						}
						maputils.createOpacityControl(this.gmap, mapType,
								this.model);
					}
				},

				panMapToCenterPoint : function() {
					var centerLat = this.model.get('centerLat');
					var centerLon = this.model.get('centerLon');
					var latLng = new google.maps.LatLng(centerLat, centerLon);
					this.gmap.panTo(latLng);
				},

				destroyAlignedImageQtree : function() {
//					if (this.alignedImageVisible) {
//						this.gmap.overlayMapTypes.pop();
//						this.gmap.controls[google.maps.ControlPosition.TOP_RIGHT]
//								.pop();
//						this.alignedImageVisible = false;
//					}
				},

				refreshAlignedImageQtree : function() {
					this.destroyAlignedImageQtree();
					this.initAlignedImageQtree();
				},

				drawMarkers : function() {

					this.model.get('points').each(function(point) {
						this.renderPoint(point);
					}, this);
					// var meterCoords = { x: point[0], y: point[1] };
					// if (! _.any(_.values(meterCoords), _.isNull)) {
					// var latLon = metersToLatLon(meterCoords);
					// latLons.push(latLon);
					// }
					// }, this);
					// result = this._drawMarkers(latLons);
				},

				// updateTiepointFromMarker: function(index, marker) {
				// var coords = latLonToMeters(marker.getPosition());
				// this.model.updateTiepoint('map', index, coords);
				// },

				showCurrentInfo : function() {
					/*
					 * // shows the lat lon of where the cursor is on the map //
					 * shows current center point value var positionBox = $('<div
					 * id="positionBox">' + '<div id="imageID"><strong>' +
					 * this.model.attributes.issMRF + '</strong></div>' + '<div
					 * id="mapPos"> </div>' + '<div id="centerPtLatLon">
					 * </div>' + '</div>');
					 * $('#workflow_controls').before(positionBox); var mapPos =
					 * positionBox.find('#mapPos'); var centerPtLatLon =
					 * positionBox.find('#centerPtLatLon');
					 * google.maps.event.addListener(this.gmap, 'mousemove',
					 * function (event) { mapPos.text("Cursor (lat, lon): " +
					 * event.latLng); var latlon =
					 * maputils.getLatLonFromMarkerTitle(centerPointMarker);
					 * centerPtLatLon.text('Image Center Point (lat,lon): ' +
					 * latlon[0] + ', ' + latlon[1]); });
					 */},

			}); // end MapView

	// OpenSeadragon image view
	app.views.ImageQtreeView = app.views.OverlayView.extend({
		// modes
		template : $('#template-osd-image-viewer').html(),
		initialize : function(options) {
			app.views.OverlayView.prototype.initialize.apply(this, arguments);
			vent.on('navigate', function() {
				this.navigate();
			}, this);
			vent.on('startAddTiepoint', function() {
				this.addTiepoints();
			}, this);
			vent.on('startDeleteTiepoint', function() {
				this.deleteTiepoints();
			}, this);
			this.model.on('add:points', function(point) {
				this.renderPoint(point);
			}, this);
		},
		renderPoint : function(point) {
			if (!_.isEmpty(point.get('imageCoords'))) {
				new app.views.ImageTiePointView({
					model : point,
					viewer : this.viewer
				});
			}
		},
		addTiepoints : function() {
			$("#osd_viewer").css('cursor', "pointer");
			var context = this;
			// Canvas-click event handler
			this.viewer.addHandler('canvas-click', function(event) {
				context.tiepointClickHandler(event);
			});
		},
		tiepointClickHandler : function(event) {
			/*
			 * If the canvas is clicked, calculate 3 points 1.) webPoint: Normal
			 * pixel coordinates of the webpage 2.) viewportPoint: OSD's
			 * coordinate system i.) "By default, a single image will be placed
			 * with its left side at viewport x = 0 and its right side at
			 * viewport x = 1. The default top is at at viewport y = 0 and its
			 * bottom is wherever is appropriate for the image's aspect ratio.
			 * For instance, the bottom of a square image would be at y = 1, but
			 * the bottom of an image that's twice as wide as it is tall would
			 * be at y = 0.5." 3.) imagePoint: The pixel coordinates of the
			 * image
			 */
			if (app.mode == mode.ADD_TIEPOINTS) {
				actionPerformed();
				var viewportPoint = this.viewer.viewport
						.pointFromPixel(event.position);
				var imagePoint = this.viewer.viewport
						.viewportToImageCoordinates(viewportPoint);
				this.addOrUpdateTiepoint('imageCoords', [ imagePoint.x,
						imagePoint.y ]);

			}
		},
		deleteTiepoints : function() {
			$("#osd_viewer").css('cursor', "not-allowed"); // could do url(bla)
															// where bla goes to
															// X image
		},
		navigate : function() {
			$("#osd_viewer").css('cursor', "auto");
		},
		beforeRender : function() {
			// pass
		},
		afterRender : function() {
			var deepzoomTileSource = this.model.get('deepzoom_path');
			this.viewer = OpenSeadragon({
				id : "osd_viewer",
				prefixUrl : "/static/external/js/openseadragon/images/",
				tileSources : deepzoomTileSource,
				toolbar: "toolbarDiv",
				gestureSettingsMouse : {
					clickToZoom : false,
					dblClickToZoom : false
				}
			});

			var viewer = this.viewer;
			
			// Using jQuery UI slider
			$("#rotation_slider").slider({
				min : -180,
				max : 180,
				slide : function(event, ui) {
					viewer.viewport.setRotation(ui.value);
				}
			});

			var model = this.model;
			this.viewer.addHandler('open', function() {
				// construct prior tiepoints
				model.get('points').each(function(point) {
					new app.views.ImageTiePointView({
						model : point,
						viewer : viewer
					});
				});

			});
			// on center point click, display the lat lon script
			$('#center_pt_button').click(function(){
				var lat = model.get('centerLat');
				var lon = model.get('centerLon');
				var bingMapScript = maputils.latLonToCatalogBingMapsClipboardScript(lat,lon);
				maputils.copyToClipboard(lat, lon, bingMapScript);
			});
		}
	});

	app.views.SplitOverlayView = app.views.OverlayView
			.extend({
				events : {
					'click #btn_navigate' : function() {
						vent.trigger('navigate', mode.NAVIGATE);
					},
					'click #btn_add_tiepoint' : function() {
						vent.trigger('startAddTiepoint', mode.ADD_TIEPOINTS);
					},
					'click #btn_delete_tiepoint' : function() {
						vent.trigger('startDeleteTiepoint',
								mode.DELETE_TIEPOINTS);
					},
				},

				initialize : function(options) {
					app.views.OverlayView.prototype.initialize.apply(this,
							arguments);
					vent.on('navigate', function(mode) {
						this.updateMode(mode);
					}, this);
					vent.on('startAddTiepoint', function(mode) {
						this.updateMode(mode);
					}, this);
					vent.on('startDeleteTiepoint', function(mode) {
						this.updateMode(mode);
					}, this);
					this.model.on('points_lt_2', function(save) {
						this.handleFewPoints(save);
					}, this);
				},
				handleFewPoints : function(save) {
					$('input#done').prop('checked', false);
				},
				updateMode : function(newmode) {
					app.mode = newmode;
					switch (newmode) {
					case mode.NAVIGATE:
						$("#btn_navigate").addClass('active');
						$("#btn_add_tiepoint").removeClass('active');
						$("#btn_delete_tiepoint").removeClass('active');
						break;
					case mode.ADD_TIEPOINTS:
						$("#btn_navigate").removeClass('active');
						$("#btn_add_tiepoint").addClass('active');
						$("#btn_delete_tiepoint").removeClass('active');
						break;
					case mode.DELETE_TIEPOINTS:
						$("#btn_navigate").removeClass('active');
						$("#btn_add_tiepoint").removeClass('active');
						$("#btn_delete_tiepoint").addClass('active');
						break;
					}
				},
				helpSteps : [
						{
							promptText : 'Click matching landmarks on both sides'
									+ ' to add tiepoints and align your overlay.',
							videoId : '95h45vkpxr8'
						},
						{
							promptText : 'Use "Share" to see options for viewing '
									+ 'your overlay in maps outside this site.',
							videoId : 'rgNW5Iaq1Dw',
							helpFunc : function() {
								this.$('#export').focus();
								flicker(function() {
									this.$('#export').addClass('btn-primary');
								}, function() {
									this.$('#export')
											.removeClass('btn-primary');
								}, 500, 3);
							}
						} ],

				template : $('#template-overlay-dashboard').html(),

				beforeRender : function() {
					if (this.helpIndex == null) {
						if (this.model == undefined
								|| this.model.get('alignedTilesUrl')) {
							this.helpIndex = 1;
						} else {
							this.helpIndex = 0;
						}
					}
					this.context = {
						issMRF : this.model.get('issMRF'),
						width : this.model.get('imageSize')[0],
						height : this.model.get('imageSize')[1]
					}
				},

				afterRender : function() {
					this.$('#split_container').splitter({
						resizeToWidth : true,
						dock : 'right'
					});
					$('#promptHelp').click(function() {
						$('#helpText').modal('show');
					});
					$('#helpCloseBtn').click(function() {
						$('#helpText').modal('hide');
					});
					this.imageView = new app.views.ImageQtreeView({
						el : '#split_right',
						model : this.model,
						debug : false,
					}).render();
					this.imageView = null;
					this.mapView = new app.views.MapView({
						el : '#split_left',
						model : this.model
					}).render();

					var splitview = this;
					var subviews = [ this.mapView ];
					this.$('#split_container').bind('resize', function(evt) {
						// ensure Google Maps instances get resized when the
						// splitter moves.
						_.each(subviews, function(subview) {
							google.maps.event.trigger(subview.gmap, 'resize');
						});
					});

					maputils.locationSearchBar('#locationSearch',
							this.mapView.gmap);
					this.initButtons();
					this.initWorkflowControls();
					this.initMarkerSelectHandlers();
					(this.model.on('add_point redraw_markers',
							this.initMarkerSelectHandlers, this));

					this.renderHelp();
					this.animatePrompt();
					enableUndoButtons();
				},

				renderHelp : function() {
					var helpData = this.helpSteps[this.helpIndex];
					this.$('#userPromptText').html(helpData.promptText);
					// this.$('#modalBody').html(helpData[1]);
					var videoView = new app.views.HelpVideoView({
						el : this.$('#modalBody'),
						videoId : helpData.videoId,
						parentView : this
					});
					videoView.render();
					if (helpData.helpFunc) {
						_.bind(helpData.helpFunc, this)();
					}

					if (this.helpIndex == 0) {
						this.$('#promptPrevStep').attr('disabled', 'disabled');
					} else {
						this.$('#promptPrevStep').removeAttr('disabled');
					}
					if (this.helpIndex == this.helpSteps.length - 1) {
						this.$('#promptNextStep').attr('disabled', 'disabled');
					} else {
						this.$('#promptNextStep').removeAttr('disabled');
					}
				},

				animatePrompt : function() {
					var prompt = $('.instructions-prompt');
					var startProps = {
						position : 'relative',
						'z-index' : 1000,
						top : '300px'
					};
					var endProps = {
						top : '0px',
						left : '0px'
					};
					prompt.css(startProps);
					prompt.animate(endProps, {
						duration : 1500,
						complete : function() {
							prompt.css('position', 'static');
						}
					});
				},

				prevHelpStep : function() {
					if (this.helpIndex > 0)
						this.helpIndex--;
					this.renderHelp();
				},

				nextHelpStep : function() {
					if (this.helpIndex < this.helpSteps.length)
						this.helpIndex++;
					this.renderHelp();
				},

				zoomMaximum : function() {
					// var imageZoom = this.imageView.model.maxZoom();
					var imageZoom = (this.imageView.gmap.mapTypes
							.get('image-map').maxZoom);
					(google.maps.event
							.addListenerOnce(this.imageView.gmap,
									'bounds_changed', _.bind(
											this.matchImageZoom, this)));
					this.imageView.gmap.setZoom(imageZoom);

					var isSelected = function(marker) {
						return marker.get('selected');
					};
					if (_.any(this.mapView.markers, isSelected)) {
						var selected = _.find(this.mapView.markers, isSelected);
						var idx = _.indexOf(this.mapView.markers, selected);
						this.mapView.gmap
								.panTo(this.mapView.markers[idx].position);
						this.imageView.gmap
								.panTo(this.imageView.markers[idx].position);
					}
				},

				zoomFit : function() {
					this.imageView.gmap.fitBounds(this.model.imageBounds());
					this.mapView.gmap.fitBounds(this.model.mapBounds());
				},

				matchImageZoom : function() {
					function logBounds(bounds) {
						console.log('SW: ' + bounds.getSouthWest().toString());
						console.log('NE: ' + bounds.getNorthEast().toString());
					}
					// transform the bounds of the image view into map space and
					// zoom/pan the map view to fit.
					var transform = (geocamTiePoint.transform
							.deserializeTransform(this.model.get('transform')));
					var imageBounds = this.imageView.gmap.getBounds();
					var mapBounds = new google.maps.LatLngBounds();
					console.log('Image Bounds');
					logBounds(imageBounds);
					(mapBounds.extend(forwardTransformLatLon(transform,
							imageBounds.getSouthWest())));
					(mapBounds.extend(forwardTransformLatLon(transform,
							imageBounds.getNorthEast())));
					// console.log("Map Bounds");
					// logBounds(mapBounds);
					maputils.fitMapToBounds(this.mapView.gmap, mapBounds);
				},

				initButtons : function() {
					var view = this;
					var zoomed = null;
					this.$('button#zoom_100').click(function() {
						zoomed = true;
						view.zoomMaximum();
					});
					this.$('button#zoom_fit').click(function() {
						zoomed = false;
						view.zoomFit();
					});
					$(document).keyup(function(e) {
						console.log('key detect: ' + e.which);
						switch (e.which) {
						// match z or Z
						case 122:
						case 90:
							if (e.ctrlKey) { // todo: command-key support for
												// os x
								// ctrl-z: undo
								undo();
								break;
							}
							zoomed = !zoomed;
							if (zoomed) {
								view.zoomMaximum();
							} else {
								view.zoomFit();
							}
							break;
						case 89: // y
							if (e.ctrlKey)
								redo();
						case 46: // delete
							// TODO: make this work with backspace without
							// triggering the default (prev page) behavior
							// case 8: // backspace
							$('button#delete').click();
							break;
						default:
							return true;
						}
						e.preventDefault();
						return false;
					});

					this.$('button#help, button#video').click(function() {
						$('#helpText').modal('show');
					});
					this.$('#promptPrevStep').click(
							_.bind(this.prevHelpStep, this));
					this.$('#promptNextStep').click(
							_.bind(this.nextHelpStep, this));
				},

				// observePoints: function() {
				// if (this.get('points').length >= 2) {
				// if (_.filter(this.get('points'),
				// function(p) {
				// return _.all(p, _.identity);
				// }).length >= 2) {
				// save_button.attr('disabled', false);
				// done_button.attr('disabled', false);
				// this.off('change:points', observePoints);
				// }
				// }
				// },

				initWorkflowControls : function() {
					var splitView = this;
					var overlay = this.model;

					// Don't allow the user to save the tiepoints until at least
					// two are defined.
					// TODO why?
					// if (! overlay.get('points') ||
					// overlay.get('points').length < 2) {
					// // var save_button = $('button#save');
					// // save_button.attr('disabled', true);
					//                
					// var done_button = $('button#done');
					// done_button.attr('disabled', true);
					//                
					// overlay.on('change:points', this.observePoints, overlay);
					// }

					$('button#save').click(
							function() {
								var button = $(this);
								button.data('original-text', button.text());
								overlay.warp({
									success : function(model, response) {
										$('input#show_preview').attr('checked',
												true).change();
									}
								});
							});

					var saveStatus = $('#saveStatus');
					this.model
							.on(
									'before_warp',
									function() {
										// saveStatus.text(saveStatus.data('saving-text'));
										saveStatus
												.html('<img src="/static/geocamTiePoint/images/loading.gif">');
									})
					this.model.on('warp_success', function() {
						saveStatus.text(saveStatus.data('saved-text'));
					})

					this.model.on('warp_server_error', function() {
						saveStatus.html($('<span class="error">').text(
								saveStatus.data('server-error')));
					})

					this.model.on('warp_server_unreachable', function() {
						saveStatus.html($('<span class="error">').text(
								saveStatus.data('server-unreachable')));
					});

					$('button#export').click(
							function() {
								app.router.navigate('overlay/' + overlay.id
										+ '/export', {
									trigger : true
								});
							});

					$('input#show_preview').change(function(evt) {
						if (this.checked) {
							splitView.mapView.overlay_enabled = true;
							splitView.mapView.initAlignedImageQtree();
						} else {
							splitView.mapView.overlay_enabled = false;
							splitView.mapView.destroyAlignedImageQtree();
						}
					});

					if (overlay.get('readyToExport')) {
						$('input#done').prop('checked', true);
					}

					//TODO not sure how readonly is ever set
					var readonly = false;
					if (readonly) {
						$("#btn_add_tiepoint").prop("disabled", true);
						$("#btn_delete_tiepoint").prop("disabled", true);
					}
					$('input#done').change(function(evt) {
						if (this.checked) {
							overlay.set('readyToExport', true);
							overlay.save({
								'readyToExport' : 1
							}, overlay.defaultSaveOptions);
						} else {
							overlay.set('readyToExport', false);
							overlay.save({
								'readyToExport' : 0
							}, overlay.defaultSaveOptions);
						}
					});

					this.on('change_selection', function() {
						var selectedMarkers = this.selectedMarkers();
						var markerSelected = _.any(selectedMarkers,
								function(i) {
									return i > -1;
								});
						$('button#delete').attr('disabled', !markerSelected);
					});
					$('button#delete').click(
							function() {
								var views = [ splitView.mapView,
										splitView.imageView ];
								var selected = _.map(views, function(v) {
									return v.getSelectedMarkerIndex();
								});
								selected = _.filter(selected, function(s) {
									return s >= 0
								});
								if (selected.length === 0) {
									return false;
								} else if (selected.length === 2) {
									assert(selected[0] === selected[1],
											'Selected markers do not match.');
								}
								actionPerformed();
								selected = selected[0];
								overlay.deleteTiepoint(selected);
								_.each(views, function(v) {
									v.selectMarker(null);
								});
								overlay.trigger('redraw_markers');
							});
				},

				initMarkerSelectHandlers : function() {
					/*
					 * Clear any extant select handlers, lest they get
					 * duplicated
					 */
					var selectHandlers = this._selectHandlers = this._selectHandlers
							|| [];
					while (selectHandlers.length > 0) {
						google.maps.event.removeListener(selectHandlers.pop());
					}
					var splitView = this;
					var views = [ this.imageView, this.mapView ];
					/* Select one pair of markers at a time */
					// _.each(views, function(view) {
					// _.each(view.markers, function(marker, index) {
					// selectHandlers.push(
					// google.maps.event.addListener(
					// marker, 'mousedown', function() {
					// splitView.selectMarker(index);
					// }
					// )
					// );
					// });
					// });
				},

				selectedMarkers : function() {
					var views = [ this.mapView, this.imageView ];
					return _.map(views, function(v) {
						return v.getSelectedMarkerIndex();
					});
				},

				selectMarker : function(index) {
					var views = [ this.mapView, this.imageView ];
					_.each(views, function(view) {
						view.selectMarker(index);
					});
				}

			}); // end SplitOverlayView

	app.views.HelpVideoView = app.views.View
			.extend({

				template : '<div id="helpVideo">'
						+ '<div class="btn-group floatleft" style="margin-right: 10px;">'
						+ '<a id="helpPrev" class="btn btn-mini" '
						+ '{{#if first}}disabled="true"{{/if}} >&lt;&lt;</a>'
						+ '<a id="helpNext" class="btn btn-mini" '
						+ '{{#if last}}disabled="true"{{/if}}>&gt;&gt;</a>'
						+ '</div>'
						+ '<embed id="videoEmbed" width="560" height="315" '
						+ 'src="//www.youtube.com/v/'
						+ '{{videoId}}?version=3&enablejsapi=1">' + '</embed>'
						+ '<div class="videoCaption">{{captionText}}</div>'
						+ '</div>',

				initialize : function(options) {
					this.options = options;
					var parentView = options.parentView;
					this.context = {
						videoId : options.videoId,
						captionText : options.captionText,
						first : parentView.helpIndex == 0,
						last : (parentView.helpIndex == (parentView.helpSteps.length - 1))
					};
				},

				afterRender : function() {
					var modal = this.$el.parent('.modal');
					var thisview = this;

					modal.off('.video_help');
					modal.on('hide.video_help', function() {
						var video = $(this).find('#videoEmbed');
						// TODO: fix this so that the video doesn't have to
						// reload if you open the help multiple times
						// video[0].pauseVideo();
						video.remove();
					});
					modal.on('shown.video_help', function() {
						thisview.render();
					});
					(this.$('#helpPrev').click(_.bind(
							this.options.parentView.prevHelpStep,
							this.options.parentView)));
					(this.$('#helpNext').click(_.bind(
							this.options.parentView.nextHelpStep,
							this.options.parentView)));
				}

			});

	// FIX: requirements text hard-coded, should auto-update based on settings
	var importRequirementsText = '[Size < 2 MB. Acceptable formats: JPEG, PDF, PNG, and others]';

	app.views.NewOverlayView = app.views.View
			.extend({
				template : $('#template-create-overlay').html(),

				initialize : function() {
					app.views.View.prototype.initialize.apply(this, arguments);
					// data to pass to handlebars template
					this.context = {
						overlays : app.overlays.toJSON(),
						importRequirementsText : importRequirementsText,
						token : window.csrf_token,
					};
				},

				startSpinner : function(index, imageId) {
					var childNum = index + 1;
					$("#create_overlays tr:nth-child(" + childNum + ")").html(
							'<img src="/static/geocamTiePoint/images/loading.gif">'
									+ '&nbsp;' + 'Creating overlay ' + imageId
									+ '...');
				},

				createEditLink : function(index, url, imageId) {
					var childNum = index + 1;
					$("#create_overlays tr:nth-child(" + childNum + ")").html(
							'<a href="' + url + '" target="_blank">' + imageId
									+ '</a>');

				},

				showCreateMoreBtn : function(createBtn) {
					// once the overlays are created, show create more -> routes
					// back to location reload.
					createBtn.prop("disabled", false);
					createBtn
							.replaceWith($('<input type="button" value = "Create more" onclick="location.reload()";/>'));
				},

				submitForm : function() {
					// send the create overlay request to the server.
					var imageIdJson = {};
					var $inputs = $('input.imageId');

					// send ajax request for each image id to create a new
					// overlay
					$inputs.each(function(index) {
						var imageId = $(this).val();
						imageIdJson[index] = imageId;
						// start the spinner
						that.startSpinner(index, imageId);

						var createBtn = $('#createOverlaysButton');
						createBtn.prop("disabled", true);

						// send this to the server
						$.ajax({
							url : '/overlays/new.json',
							type : 'POST',
							data : imageIdJson,
							dataType : 'json',
							success : function(data) {
								// replace the spinner with a hyperlink to the
								// url.
								that
										.createEditLink(index, data['url'],
												imageId);
								// replace the upload btn with upload more
								if (index == 0) {
									that.showCreateMoreBtn(createBtn);
								}
							},
							error : function(xhr, status, error) {
								console.log("xhr", xhr);
								console.log("status", status);
								alert("error in NewOverlayView: ", error);
							}
						});
					});
				},

				afterRender : function() {
					that = this;
					this.$('#createOverlaysButton').click(this.submitForm);
					$('#formTabs a:first').tab('show');
					this.$('ul#formTabs a').click(function(e) {
						e.preventDefault();
						$(this).tab('show');
					});

					$('#id_add')
							.click(
									function() {
										// insert a new image ID row
										$('#create_overlays tr:last')
												.before(
														'<tr> \
            			<td class="columnSpacer"><input class="imageId" \
            			name="imageId" type="text" \
            			placeholder="i.e. ISS039-E-12345"/> </td> \
            			</tr>');
									});
				},

				getCookie : function(name) {
					var cookieValue = null;
					if (document.cookie && document.cookie != '') {
						var cookies = document.cookie.split(';');
						for (var i = 0; i < cookies.length; i++) {
							var cookie = $.trim(cookies[i]);
							if (cookie.substring(0, name.length + 1) == (name + '=')) {
								cookieValue = (decodeURIComponent(cookie
										.substring(name.length + 1)));
								break;
							}
						}
					}
					return cookieValue;
				},

				csrfSafeMethod : function(method) {
					return (/^(GET|HEAD|OPTIONS|TRACE)$/.test(method));
				},
			}); // end NewOverlayView

	app.views.DeleteOverlayView = app.views.View.extend({

		template : '<form id="deleteOverlayForm">'
				+ '<h4>Are you sure you want to delete overlay {{name}}?</h4>'
				+ '<br>' + '<input type="button" value="Delete"'
				+ ' id="deleteOverlayFormSubmitButton" />'
				+ '<input type="button" value="Cancel"'
				+ ' id="deleteOverlayFormCancelButton" />',

		initialize : function() {
			app.views.View.prototype.initialize.apply(this, arguments);
			if (this.id && !this.model) {
				this.model = app.overlays.get(this.id);
			}
			assert(this.model, 'Requires a model!');
			this.context = this.model.toJSON();
		},

		afterRender : function() {
			this.$('input#deleteOverlayFormSubmitButton')
					.click(this.submitForm);
			this.$('input#deleteOverlayFormCancelButton').click(this.cancel);
		},

		cancel : function() {
			app.router.navigate('overlays/');
		},

		submitForm : function() {
			var key = this.context['key'];
			$.ajax({
				url : '/overlay/' + key + '/delete.html',
				crossDomain : false,
				cache : false,
				contentType : false,
				processData : false,
				type : 'POST',
				success : app.views.DeleteOverlayView.prototype.submitSuccess
			});
		},

		submitSuccess : function(data) {
			console.log('got data back');
			app.router.navigate('overlays/');
		}
	}); // end DeleteOverlayView

	app.views.ExportOverlayView = app.views.OverlayView
			.extend({

				initialize : function() {
					app.views.OverlayView.prototype.initialize.apply(this,
							arguments);
					_.bindAll(this);
				},

				template : $('#template-share-overlays').html(),

				afterRender : function() {
					this.$('#create_html_archive').click(
							_.bind(this.requestExport, this, 'html'));
					if (this.model.htmlExportPending) {
						this.startSpinner('html');
					}
					this.$('#create_kml_archive').click(
							_.bind(this.requestExport, this, 'kml'));
					if (this.model.kmlExportPending) {
						this.startSpinner('kml');
					}
					this.$('#create_geotiff_archive').click(
							_.bind(this.requestExport, this, 'geotiff'));
					if (this.model.geotiffExportPending) {
						this.startSpinner('geotiff');
					}
				},

				requestExport : function(type) {
					var createArchiveElem = '#create_' + type + '_archive';
					this.$(createArchiveElem).attr('disabled', true);
					this.model.startExport({
						error : function() {
							$('#exportError').html(
									'Error during export: ' + error);
						},
						exportType : type
					});
					this.startSpinner(type);
				},

				startSpinner : function(type) {
					thisView = this;
					var event = type + '_export_ready';
					var createArchiveElem = '#create_' + type + '_archive';
					var exportBtn = '#' + type + '_export_button';

					this.model.on(event, function onExportReady() {
						this.model.off(null, onExportReady, null);
						if (app.currentView === thisView)
							this.render();
					}, this);
					this.$(createArchiveElem).attr('disabled', true);
					(this.$(exportBtn)
							.html('<img src="/static/geocamTiePoint/images/loading.gif">'
									+ '&nbsp;'
									+ 'Creating '
									+ type
									+ ' export archive (this could take a few minutes)...'));
				}
			}); // end ExportOverlayView
}); // end jQuery ready handler
