var app = app || {};

$(function($) {
    var AppRouter = Backbone.Router.extend({
        routes: {
            'overlays/': 'listOverlays',
            'overlay/:overlay_id': 'showOverlay',
            'overlay/new': 'newOverlay',
            '': 'root'
        },

        root: function() {
            this.navigate('overlays/', {trigger: true});
        },

        listOverlays: function() {
            console.log('Routed to listOverlays.');
            var view = new app.views.ListOverlaysView();
            view.render();
        },

        showOverlay: function(overlay_id) {
            console.log('Routed to showOverlay for ' + overlay_id);
            //var view = new app.views.ImageQtreeView({id: overlay_id});
            var view = new app.views.SplitOverlayView({id: overlay_id});
            view.render();
        },

	newOverlay: function() {
	    console.log('Routed to newOveraly');
	    var view = new apps.views.NewOverlayView();
	    view.render();
	},

        start: function() {
            Backbone.history.start();
        }
    });

    app.router = new AppRouter();

});
