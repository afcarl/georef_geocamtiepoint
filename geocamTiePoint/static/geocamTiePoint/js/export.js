// __BEGIN_LICENSE__
// Copyright (C) 2008-2010 United States Government as represented by
// the Administrator of the National Aeronautics and Space Administration.
// All Rights Reserved.
// __END_LICENSE__

var exportCompleteTimerG = null;
var exportCompleteTimeoutG = null;

function clearErrors() {
    $('#exportError').html('');
}

function renderExportingStatus() {
    ($('#exportMain').html
     ('<table>' +
      '<tr><td style="vertical-align: middle">' +
      '<img' +
      ' src="' + STATIC_URL + 'geocamTiePoint/images/loading.gif"' +
      ' width="32"' +
      ' height="32"' +
      '/>' +
      '</td>' +
      '<td style="vertical-align: middle">' +
      'Exporting aligned overlay (may take a few minutes)' +
      '</span>' +
      '</td></tr>' +
      '</table>'));
    // TODO put in loading gif
}

function sendExportRequest() {
    var generateExportUrl = (overlay.url.replace
                             ('.json', '/generateExport'));
    ($.post(generateExportUrl,
            '', /* empty post data */
            function() {}, /* no-op on success */
            'json')
     .error(function(xhr, status, error) {
         $('#exportError').html('Error during export: ' + error);
         renderExportButton();
         cancelPollForExportComplete();
     }));
}

function checkForExportComplete() {
    $.getJSON(overlay.url, function(response) {
        overlay = response;
        if (overlay.htmlExportUrl) {
            renderDownloadLink();
            cancelPollForExportComplete();
        }
    });
}

function pollForExportComplete0() {
    checkForExportComplete();
    exportCompleteTimeoutG *= 1.5;
    exportCompleteTimerG = setTimeout(pollForExportComplete0,
                                      exportCompleteTimeoutG);
}

function pollForExportComplete() {
    exportCompleteTimeoutG = 1000;
    exportCompleteTimerG = setTimeout(pollForExportComplete0,
                                      exportCompleteTimeoutG);
}

function cancelPollForExportComplete() {
    if (exportCompleteTimerG != null) {
        clearTimeout(exportCompleteTimerG);
        exportCompleteTimerG = null;
    }
}

function handleExportClick() {
    clearErrors();
    renderExportingStatus();
    sendExportRequest();
    pollForExportComplete();
}

function renderExportButton() {
    ($('#exportMain').html
     ('<button id="generateExport" type="button">' +
      'Export Aligned Overlay</button> (may take a few minutes)'));

    $('#generateExport').click(handleExportClick);
}

function renderDownloadLink() {
    ($('#exportMain').html
     ('<a href="' +
      overlay.htmlExportUrl +
      '">Download aligned overlay in tar.gz file format</a>'));
}

function renderSorry() {
    ($('#exportMain').html
     ('Sorry, this overlay has not been aligned yet. (Set at least' +
      ' 2 pairs of tie points, save, and warp first.'));
}

function initialize() {
    if (overlay.htmlExportUrl) {
        renderDownloadLink();
    } else {
        if (overlay.alignedTilesUrl) {
            renderExportButton();
        } else {
            renderSorry();
        }
    }
}
