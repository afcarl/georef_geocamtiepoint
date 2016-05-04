# __BEGIN_LICENSE__
# Copyright (C) 2008-2010 United States Government as represented by
# the Administrator of the National Aeronautics and Space Administration.
# All Rights Reserved.
# __END_LICENSE__

from fileinput import filename

from django.shortcuts import render_to_response
from django.http import HttpResponse, HttpResponseRedirect, HttpResponseNotFound
from django.http import HttpResponseNotAllowed, Http404
from django.template import RequestContext
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.core.urlresolvers import reverse
from django.core.files import File
from django.core.cache import cache
from django.core.exceptions import ObjectDoesNotExist
from django.contrib.auth.decorators import login_required

from django.dispatch import receiver
from django.db.models.signals import pre_save, post_save, post_delete
from django.db import transaction

from geocamTiePoint.viewHelpers import *
from geocamTiePoint import forms
from geocamUtil.icons import rotate

if settings.USING_APP_ENGINE:
    from google.appengine.api import backends
    from google.appengine.api import taskqueue


@login_required
def backbone(request):
    initial_overlays = Overlay.objects.order_by('pk')
    templates = get_handlebars_templates(settings.GEOCAM_TIE_POINT_HANDLEBARS_DIR)
    if request.method == 'GET':
        return render_to_response('geocamTiePoint/backbone.html',
            {
                'templates': templates,
                'initial_overlays_json': dumps(list(o.jsonDict for o in initial_overlays)) if initial_overlays else [],
                'settings': export_settings(),
                'cameraModelTransformFitUrl': reverse('geocamTiePoint_cameraModelTransformFit'), 
                'cameraModelTransformForwardUrl': reverse('geocamTiePoint_cameraModelTransformForward'), 
                'rotateOverlayUrl': reverse('geocamTiePoint_rotateOverlay'),
                'enhanceImageUrl': reverse('geocamTiePoint_createEnhancedImageTiles')
            },
            context_instance=RequestContext(request))
    else:
        return HttpResponseNotAllowed(['GET'])


@login_required
def overlayDelete(request, key):
    if request.method == 'GET':
        overlay = get_object_or_404(Overlay, key=key)
        return render_to_response('geocamTiePoint/overlay-delete.html',
                                  {'overlay': overlay,
                                   'overlayJson': dumps(overlay.jsonDict)},
                                  context_instance=RequestContext(request))
    elif request.method == 'POST':
        overlay = get_object_or_404(Overlay, key=key)
        overlay.delete()
        return HttpResponseRedirect(reverse('geocamTiePoint_overlayIndex'))

 
@csrf_exempt
def createEnhancedImageTiles(request):
    """
    Receives request from the client to enhance the images. The
    type of enhancement and value are specified in the 'data' json
    package from client.
    """
    if request.is_ajax() and request.method == 'POST':
        data = request.POST
        enhanceType = data['enhanceType']
        value = None
        if 'value' in data:
            value = float(data['value'])
        overlayId = data["overlayId"]
        # get the overlay
        overlay = Overlay.objects.get(key=overlayId)
        # save the previous unaligned quadtree
        previousQuadTree = None
        if overlay.imageData.raw != True: 
            previousQuadTree = overlay.unalignedQuadTree
        imageData = overlay.imageData
        # save the new enhancement value in database
        saveEnhancementValToDB(imageData, enhanceType, value)   
        # enhance the image
        checkAndApplyEnhancement(imageData, enhanceType)     
        overlay.imageData.save()
        overlay.save()
        # generate a new quadtree for display
        overlay.generateUnalignedQuadTree()  # generate tiles
        if previousQuadTree != None:
            previousQuadTree.delete()  # delete the old tiles
        data = {'status': 'success', 'id': overlay.key}
        return HttpResponse(json.dumps(data))
       

@csrf_exempt
def rotateOverlay(request):
    """
    Called in response to the ajax request sent from the client when 
    user moves the rotation slider or inputs rotation. 

    re renders page with rotated image.
    """
    if request.is_ajax() and request.method == 'POST':
        data = request.POST
        # get the rotation angle input from the user
        rotationAngle = data["rotation"]        
        rotationAngle = int(rotationAngle) # convert str to int
        # get the id of the current overlay
        overlayId = data["overlayId"]
        # get the overlay object
        overlay = Overlay.objects.get(key=overlayId)
        # add the user's new rotation request to the total rotation
        overlay.extras.totalRotation = rotationAngle
        # original image uploaded by the user
        rawImageData = overlay.getRawImageData()
        rawPILimage = getPILimage(rawImageData)
        # save out the original image size
        overlay.extras.orgImageSize = rawPILimage.size
        #rotate the image (minus sign since PIL rotates counter clockwise)
        rotatedImage = rawPILimage.rotate(-1*overlay.extras.totalRotation, 
                                            PIL.Image.BICUBIC, expand=1)
        # data that needs to be deleted after overlay save
        isRaw = overlay.imageData.raw
        previousImageDataId = overlay.imageData.id
        previousQuadTreeId = overlay.unalignedQuadTree.id
        # create a new image data object with new image
        newImageData = overlay.imageData
        newImageData.pk = None
        newImageData.raw = False
        # save the rotated image to the new ImageData object
        out = StringIO()
        rotatedImage.save(out, format='png')
        convertedBits = out.getvalue()
        out.close()
        newImageData.image.save("dummy.jpg", ContentFile(convertedBits), save=False)
        newImageData.contentType = 'image/png'
        newImageData.rotationAngle = overlay.extras.totalRotation
        newImageData.save()
        # replace the imageData of overlay
        overlay.imageData = newImageData
        overlay.extras.rotatedImageSize = rotatedImage.size
        overlay.save()
        # generate new set of tiles
        overlay.generateUnalignedQuadTree()
        
        if not isRaw:
            QuadTree.objects.get(id=previousQuadTreeId).delete()
            ImageData.objects.get(id=previousImageDataId).delete()
        
        data = {'status': 'success', 'id': overlay.key}
        return HttpResponse(json.dumps(data))
        

@csrf_exempt
def cameraModelTransformFit(request):
    """
    Handles the call from the client side, which is sent 
    when "CameraModelTransform.fit" is called from transform.js. 
    Returns the optimized parameters returned by 'fit' in the CameraModelTransform class. 
    """ 
    if request.is_ajax() and request.method == 'POST':
        data = request.POST
        toPtsX = []
        toPtsY = []
        fromPtsX = []
        fromPtsY = []
        issImageId = ""
        for key, value in data.iterlists():
            if 'imageId' in key:
                issImageId = value[0] # want the str, not the list.
            elif 'toPts[0][]' == key:
                toPtsX = value
            elif 'toPts[1][]' == key:
                toPtsY = value
            elif 'fromPts[0][]' in key:
                fromPtsX = value
            elif 'fromPts[1][]' in key:
                fromPtsY = value
        toPts = arraysToNdArray(toPtsX, toPtsY)
        fromPts = arraysToNdArray(fromPtsX, fromPtsY)
        tform = transform.CameraModelTransform.fit(toPts, fromPts, issImageId)
        params = tform.params
        params = ndarrayToList(params)
        return HttpResponse(json.dumps({'params': params}), content_type="application/json")
    else: 
        return HttpResponse(json.dumps({'Status': "error"}), content_type="application/json")


@csrf_exempt
def cameraModelTransformForward(request):
    if request.is_ajax() and request.method == 'POST':
        data = request.POST
        pt = data.getlist('pt[]', None)
        params = data.getlist('params[]', None)
        issMRF = data.get('imageId', None)
        mission, roll, frame = issMRF.split('-')
        issImage = ISSimage(mission, roll, frame, '')
        # get the width and height from imageId
        width = issImage.extras.width
        height = issImage.extras.height
        Fx = issImage.extras.focalLength[0]
        Fy = issImage.extras.focalLength[1]
        # create a new transform and set its params, width, and height
        params = [float(param) for param in params]  # convert params from unicode to float.
        pt = [float(c) for c in pt]  # convert pt from unicode to float.
        tform = transform.CameraModelTransform(params, width, height, Fx, Fy)
        # call forward on it
        meters = tform.forward(pt)
        return HttpResponse(json.dumps({'meters': meters}), content_type="application/json")
    else: 
        return HttpResponse(json.dumps({'Status': "error"}), content_type="application/json")


def createOverlayAPI(request, mission, roll, frame, sizeType):
    """
    API for creating an overlay via hitting a URL. For integration with Catalog.
    """
    imageUrl = None
    overlay = None
    issImage = ISSimage(mission, roll, frame, sizeType)
    imageUrl = issImage.imageUrl
    imageFile = imageInfo.getImageFile(imageUrl)
    if checkIfErrorJSONResponse(imageFile):
        return imageFile
    overlay = createOverlay(request.user, imageFile, issImage)
    # check if createOverlay returned a ErrorJSONResponse (if so, return right away)
    if checkIfErrorJSONResponse(overlay):
        return retval
    overlay.generateUnalignedQuadTree()
    redirectUrl = "b/#overlay/" + str(overlay.key) + "/edit"
    return HttpResponseRedirect(settings.SCRIPT_NAME + redirectUrl)


@csrf_exempt
def overlayNewJSON(request):
    """
    This gets called when user submits a create new overlay form. 
    """
    # if this is a POST request we need to process the form data
    if request.method == 'POST':
        # create a form instance and populate it with data from the request:
        form = forms.NewImageDataForm(request.POST, request.FILES)
        author = request.user
        issImage = None
        if form.is_valid():
            overlay = None
            if form.cleaned_data['image']: # if user uploaded a file
                overlay = createOverlayFromFileUpload(form, author)
            elif form.cleaned_data['imageUrl']:
                overlay = createOverlayFromURL(form, author)
            elif (form.cleaned_data['mission'] and form.cleaned_data['mission'] and form.cleaned_data['mission']):
                overlay, issImage = createOverlayFromID(form, author)
            else: 
                return ErrorJSONResponse("User submitted an invalid form")
            # check for error.
            if checkIfErrorJSONResponse(overlay):
                return overlay
            # generate initial quad tree
            overlay.generateUnalignedQuadTree()
            # register the overlay using feature detection if the flag is on.
            if form.cleaned_data['autoregister']:
                # Only run registerImage if the center point is available.
                errorResponse = registerImage(overlay)
                if errorResponse:
                    return errorResponse
            redirectUrl = "b/#overlay/" + str(overlay.key) + "/edit"
            return HttpResponseRedirect(settings.SCRIPT_NAME + redirectUrl)
    else:
        return HttpResponseNotAllowed(('POST'))


@csrf_exempt
def overlayIdJson(request, key):
    """ 
    triggered once there are enough tie points to calculate a transform.
    """
    if request.method == 'GET':
        overlay = get_object_or_404(Overlay, key=key)
        return HttpResponse(dumps(overlay.jsonDict), content_type='application/json')
    elif request.method in ('POST', 'PUT'):
        overlay = get_object_or_404(Overlay, key=key)
        overlay.jsonDict = json.loads(request.body)
        transformDict = overlay.extras.get('transform')
        if transformDict:
            try: 
                overlay.extras.bounds = (quadTree.imageMapBounds
                                         (overlay.extras.imageSize,
                                          transform.makeTransform(transformDict)))
                overlay.generateAlignedQuadTree()
            except:
                # could not generate aligned quad tree from opimized params
                return HttpResponse(dumps(overlay.jsonDict), content_type='application/json')        
        overlay.save()
        return HttpResponse(dumps(overlay.jsonDict), content_type='application/json')
    elif request.method == 'DELETE':
        get_object_or_404(Overlay, pk=key).delete()
        return HttpResponse("OK")
    else:
        return HttpResponseNotAllowed(['GET', 'POST', 'PUT', 'DELETE'])


@csrf_exempt
def overlayListJson(request):
    # return only the last 100 overlays for now.  if it gets longer than that, we'll implement paging.
    overlays = Overlay.objects.order_by('-lastModifiedTime')[:100]
    return HttpResponse(dumps(list(o.jsonDict for o in overlays)), content_type='application/json')


def overlayIdImageFileName(request, key, fileName):
    if request.method == 'GET':
        overlay = get_object_or_404(Overlay, key=key)
        fobject = overlay.imageData.image.file
        response = HttpResponse(fobject.read(), content_type=overlay.imageData.contentType)
        return response
    else:
        return HttpResponseNotAllowed(['GET'])


def getTileData(quadTreeId, zoom, x, y):
    gen = QuadTree.getGeneratorWithCache(quadTreeId)
    try:
        return gen.getTileData(zoom, x, y)
    except quadTree.ZoomTooBig:
        return transparentPngData()
    except quadTree.OutOfBounds:
        return transparentPngData()


def neverExpires(response):
    """
    Manually sets the HTTP 'Expires' header one year in the
    future. Normally the Django cache middleware handles this, but we
    are directly using the low-level cache API.

    Empirically, this *hugely* reduces the number of requests from the
    Google Maps API. One example is that zooming out one level stupidly
    loads all the tiles in the new zoom level twice if tiles immediately
    expire.
    """
    response['Expires'] = rfc822.formatdate(time.time() + 365 * 24 * 60 * 60)
    return response


def getTile(request, quadTreeId, zoom, x, y):
    quadTreeId = int(quadTreeId)
    zoom = int(zoom)
    x = int(x)
    y = int(os.path.splitext(y)[0])
    
    key = quadTree.getTileCacheKey(quadTreeId, zoom, x, y)
    data = cache.get(key)
    if data is None:
        logging.info('\ngetTile MISS %s\n', key)
        data = getTileData(quadTreeId, zoom, x, y)
        cache.set(key, data)
    else:
        logging.info('getTile hit %s', key)

    bits, contentType = data
    response = HttpResponse(bits, content_type=contentType)
    return neverExpires(response)


def getPublicTile(request, quadTreeId, zoom, x, y):
    cacheKey = 'geocamTiePoint.QuadTree.isPublic.%s' % quadTreeId
    quadTreeIsPublic = cache.get(cacheKey)
    if quadTreeIsPublic is None:
        logging.info('getPublicTile MISS %s', cacheKey)
        try:
            q = QuadTree.objects.get(id=quadTreeId)
            overlay = q.alignedOverlays.get()
        except ObjectDoesNotExist:
            overlay = None
        if overlay:
            quadTreeIsPublic = overlay.isPublic
        else:
            quadTreeIsPublic = False
        cache.set(cacheKey, quadTreeIsPublic, 60)
    else:
        logging.info('getPublicTile hit %s', cacheKey)

    if quadTreeIsPublic:
        return getTile(request, quadTreeId, zoom, x, y)
    else:
        return HttpResponseNotFound('QuadTree %s does not exist or is not public'
                                    % quadTreeId)


def dummyView(*args, **kwargs):
    return HttpResponseNotFound()


@csrf_exempt
def overlayGenerateExport(request, key, type):
    if request.method == 'GET':
        return (HttpResponse
                ('<form action="." method="post">'
                 + '<input type="submit" name="submit"'
                 + ' value="Create Export Archive"/>'
                 + '</form>'))
    elif request.method == 'POST':
        if settings.USING_APP_ENGINE:
            onFrontEndInstance = (backends.get_backend() == None)
            if onFrontEndInstance:
                # on app engine, quadTree generation may take too long
                # for a frontend instance, so we pass it to a backend
                taskqueue.add(url='/backend' + request.path,
                              target='processing')
                return HttpResponse('{"result": "ok"}',
                                    content_type='application/json')
        overlay = get_object_or_404(Overlay, key=key)
        if type == 'html':
            overlay.generateHtmlExport()
        elif type == 'kml':
            overlay.generateKmlExport()
        elif type == 'geotiff':
            overlay.generateGeotiffExport()
        else: 
            return HttpResponse('{"result": "error! Export type invalid."}',
                            content_type='application/json')
 
        return HttpResponse('{"result": "ok"}',
                            content_type='application/json')
    else:
        return HttpResponseNotAllowed(['GET', 'POST'])


def overlayExport(request, key, type, fname):
    """
    Displays the generated exports.
    """
    if request.method == 'GET':
        overlay = get_object_or_404(Overlay, key=key)
        if type == 'html': 
            if not (overlay.alignedQuadTree and overlay.alignedQuadTree.htmlExport):
                raise Http404('no export archive generated for requested overlay yet')
            return HttpResponse(overlay.alignedQuadTree.htmlExport.file.read(),
                                content_type='application/x-tgz')
        elif type == 'kml':
            if not (overlay.alignedQuadTree and overlay.alignedQuadTree.kmlExport):
                raise Http404('no export archive generated for requested overlay yet')
            return HttpResponse(overlay.alignedQuadTree.kmlExport.file.read(),
                                content_type='application/x-tgz')
        elif type == 'geotiff':
            if not (overlay.alignedQuadTree and overlay.alignedQuadTree.geotiffExport):
                raise Http404('no export archive generated for requested overlay yet')
            return HttpResponse(overlay.alignedQuadTree.geotiffExport.file.read(),
                                content_type='application/x-tgz')
    else:
        return HttpResponseNotAllowed(['GET'])


@csrf_exempt
def getExportFilesList(request):
    """
    Downloads a csv file containing list of all available export products (kml, geotiff, html).
    """
    response = HttpResponse(content_type='text/plain')
    response['Content-Disposition'] = 'attachment; filename="GeoRefExportProductsList.txt"'
    exports = QuadTree.objects.values_list('htmlExportName', 'geotiffExportName', 'kmlExportName')
    writer = csv.writer(response)
    for set in exports:
        if set is not (None, None, None):
	    for data in set:
	    	if (data != None) and (data != ''):
                    writer.writerow([data])
    return response


@csrf_exempt
def getExportFile(request, name):
    if "kml" in name:
        quadTree = QuadTree.objects.filter(kmlExportName = name)[0]
        return HttpResponse(quadTree.kmlExport.file.read(),
                            content_type='application/x-tgz')
    elif "geotiff" in name:
        quadTree = QuadTree.objects.filter(geotiffExportName = name)[0]
        return HttpResponse(quadTree.geotiffExport.file.read(),
                            content_type='application/x-tgz')
    elif "html" in name:
        quadTree = QuadTree.objects.filter(htmlExportName = name)[0]
        return HttpResponse(quadTree.htmlExport.file.read(),
                            content_type='application/x-tgz')
    else:
        raise Http404('Export file of the name %s does not exist' % name)


@csrf_exempt
def garbageCollect(request, dryRun='1'):
    if request.method == 'GET':
        return render_to_response('geocamTiePoint/gc.html',
                                  {},
                                  context_instance=RequestContext(request))
    elif request.method == 'POST':
        dryRun = int(dryRun)
        garbage.garbageCollect(dryRun)
        return HttpResponse('{"result": "ok"}', content_type='application/json')
    else:
        return HttpResponseNotAllowed(['GET', 'POST'])


def simpleAlignedOverlayViewer(request, key, slug=None):
    if request.method == 'GET':
        overlay = get_object_or_404(Overlay, key=key)
        return HttpResponse(overlay.getSimpleAlignedOverlayViewer(request))
    else:
        return HttpResponseNotAllowed(['GET'])
