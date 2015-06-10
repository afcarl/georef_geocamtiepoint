# __BEGIN_LICENSE__
# Copyright (C) 2008-2010 United States Government as represented by
# the Administrator of the National Aeronautics and Space Administration.
# All Rights Reserved.
# __END_LICENSE__

from django.conf.urls.defaults import url, patterns
from django.shortcuts import redirect
from django.core.urlresolvers import reverse

urlpatterns = patterns(
    'geocamTiePoint.views',

    ## New Workflow ##
    url(r'^b/$', 'backbone',
        {}, 'geocamTiePoint_backbone'),

    ## transform.js sends a ajax request to retrieve camera model transform value from server side. ##
    url(r'^cameraModelTransformFit/$', 'cameraModelTransformFit', 
        {}, 'geocamTiePoint_cameraModelTransformFit'),
    
    ## transform.js sends a ajax request to retrieve tformed pt in meters from server side. ##
    url(r'^cameraModelTransformForward/$', 'cameraModelTransformForward', 
        {}, 'geocamTiePoint_cameraModelTransformForward'),
    
    ## rotation slider sends ajax request to create a new overlay with rotated image ##
    url(r'^rotateOverlay/$', 'rotateOverlay', 
        {}, 'geocamTiePoint_rotateOverlay'), 
    
    ## image enhancement requests from the client handled here
    url(r'^enhanceContrast/$', 'createEnhancedImageTiles', 
        {}, 'geocamTiePoint_createEnhancedImageTiles'),    
    
    ## overlays ##
    url(r'^overlays/new\.json$', 'overlayNewJSON',
        {}, 'geocamTiePoint_overlayNew_JSON'),
                       
    ## Urls to make current pages work with new workflow ##
    url(r'^overlays/list\.html$', lambda request: redirect(reverse('geocamTiePoint_backbone') + '#overlays/'),
        {}, 'geocamTiePoint_overlayIndex'),

    url(r'^overlays/new\.html$', lambda request: redirect(reverse('geocamTiePoint_backbone') + '#overlays/new'),
        {}, 'geocamTiePoint_overlayNew'),

    url(r'^overlay/(?P<key>\d+)/generateExport/$', 'overlayGenerateExport',
        {}, 'geocamTiePoint_overlayGenerateExport'),
                       
    ## for integrating with Catalog ## 
    url(r'^catalog/(?P<mission>\w+)/(?P<roll>\w+)/(?P<frame>\d+)/(?P<size>\w+)/$', 'createOverlayFromUrl', 
        {}, 'geocamTiePoint_createOverlayFromUrl'),

    # duplicate url that starts with 'backend' so we can set 'login: admin'
    # on the backend version of the view.
    url(r'^backend/overlay/(?P<key>\d+)/generateExport/$', 'overlayGenerateExport',
        {}, 'geocamTiePoint_overlayGenerateExportBackend'),

    url(r'^overlay/(?P<key>\d+)/export\.html$', 'overlayExportInterface',
        {}, 'geocamTiePoint_overlayExportInterface'),

    url(r'^overlay/(?P<key>\d+)/export/(?P<type>\w+)/(?P<fname>[^/]*)$', 'overlayExport',
        {}, 'geocamTiePoint_overlayExport'),
    
    url(r'^overlay/(?P<key>\d+)/delete\.html$', 'overlayDelete',
        {}, 'geocamTiePoint_overlayDelete'),

    url(r'^overlay/(?P<key>\d+)/simpleViewer_(?P<slug>[^/\.]*)\.html$', 'simpleAlignedOverlayViewer',
        {}, 'geocamTiePoint_simpleAlignedOverlayViewer'),

    ## Image storage pass-thru ##
    url(r'^tile/(?P<quadTreeId>\d+)/$',
        'dummyView',
        {}, 'geocamTiePoint_tileRoot'),

    url(r'^tile/(?P<quadTreeId>[^/]+)/(?P<zoom>[^/]+)/(?P<x>[^/]+)/(?P<y>[^/]+)$',
        'getTile',
        {}, 'geocamTiePoint_tile'),

    url(r'^public/tile/(?P<quadTreeId>[^/]+)/(?P<zoom>[^/]+)/(?P<x>[^/]+)/(?P<y>[^/]+)$',
        'getPublicTile',
        {}, 'geocamTiePoint_publicTile'),

    url(r'^overlay/(?P<key>\d+)/(?P<fileName>\S+)$',
        'overlayIdImageFileName',
        {}, 'geocamTiePoint_overlayIdImageFileName'),

    ## JSON API ##
    url(r'^overlay/(?P<key>\d+).json$', 'overlayIdJson',
        {}, 'geocamTiePoint_overlayIdJson'),

    ## testing ui demo ##
    url(r'^overlays\.json$', 'overlayListJson',
        {}, 'geocamTiePoint_overlayListJson'),

    url(r'^gc/(?:(?P<dryRun>\d+)/)?$', 'garbageCollect',
        {}, 'geocamTiePoint_garbageCollect'),
    
)
