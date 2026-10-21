/* Fills in the numbers and draws the map.
 *
 * Everything here reads the same public endpoints anybody else can read. If a
 * request fails the page still says something sensible rather than sitting on
 * a row of dashes, because "we could not load this" is more useful than an
 * empty screen. */
(function () {
  'use strict';

  var nf = new Intl.NumberFormat('en-GB');

  function text(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /** Big round numbers are easier to read shortened: 41,000 becomes 41k. */
  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    return nf.format(n);
  }

  function weight(kg) {
    if (kg >= 1000) return (kg / 1000).toFixed(1).replace(/\.0$/, '') + ' t';
    return nf.format(Math.round(kg)) + ' kg';
  }

  // ── The numbers ───────────────────────────────────────────────────
  fetch('/api/v1/public/summary')
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (d) {
      text('s-fixed', compact(d.repairsFixed));
      text('s-co2', weight(d.co2SavedKg));
      text('s-sessions', compact(d.sessionsHeld));
      text('s-volunteers', compact(d.volunteers));
      text('s-recorded', compact(d.repairsRecorded));
      text('s-cafes', nf.format(d.installs));
      text('s-rate', d.successRate + '%');
      var note = d.note;
      if (d.countries > 1) note += ' Across ' + d.countries + ' countries.';
      // Say how many we heard from but could not check, rather than quietly
      // dropping them. The gap is the honest part of the number.
      if (d.reportedInstalls > 0) {
        note += ' A further ' + d.reportedInstalls + ' ' +
          (d.reportedInstalls === 1 ? 'café shares its numbers but we could not check its site, so it is'
                                    : 'cafés share their numbers but we could not check their sites, so they are') +
          ' not counted above.';
      }
      text('note', note);
      document.getElementById('stats').setAttribute('aria-busy', 'false');
      if (d.generatedAt) {
        text('updated', 'Figures updated ' + new Date(d.generatedAt).toLocaleString('en-GB'));
      }
      // Nothing has been shared yet: say so plainly rather than showing zeros
      // as though they were an achievement.
      if (d.installs === 0) {
        text('note', 'No cafés have shared their numbers yet. These figures fill in as they do.');
      }
    })
    .catch(function () {
      text('note', 'The figures could not be loaded just now. Please try again shortly.');
      text('s-fixed', '—');
      document.getElementById('stats').setAttribute('aria-busy', 'false');
    });

  // ── The map ───────────────────────────────────────────────────────

  /** A café's name, numbers and link, as nodes rather than markup, so a café
   *  name can never be read as HTML. The name comes from a public directory,
   *  but that is no reason to hand it a script tag. Called once for the list
   *  and once for the pin, since a node can only sit in one place. */
  function details(c, into) {
    var name = document.createElement('b');
    name.textContent = c.name || 'A repair café';
    var facts = document.createElement('span');
    facts.textContent =
      nf.format(c.repairsFixed) + ' fixed · ' +
      nf.format(c.sessionsHeld) + ' sessions · ' +
      weight(c.co2SavedKg) + ' saved';
    if (c.host) {
      facts.appendChild(document.createElement('br'));
      facts.appendChild(document.createTextNode('verified at ' + c.host));
    }
    into.appendChild(name);
    into.appendChild(facts);
    if (c.url) {
      var a = document.createElement('a');
      a.href = c.url;
      a.textContent = 'Visit their site';
      a.rel = 'noopener';
      a.target = '_blank';
      into.appendChild(document.createElement('br'));
      into.appendChild(a);
    }
    return into;
  }

  function hideMap() {
    document.getElementById('map').style.display = 'none';
  }

  fetch('/api/v1/public/map')
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (d) {
      var cafes = (d.cafes || []).filter(function (c) {
        return typeof c.lat === 'number' && typeof c.lng === 'number';
      });

      var sub = document.getElementById('map-sub');
      if (!cafes.length) {
        sub.textContent =
          'No cafés are on the map yet. A café appears here only if it asked to.';
        hideMap();
        return;
      }
      var count = cafes.length === 1
        ? 'One café has asked to appear here.'
        : cafes.length + ' cafés have asked to appear here.';
      sub.textContent = count + ' Click a pin for its numbers.';

      // The list does not wait for the map. MapLibre needs WebGL, and a
      // browser without it should still see who is taking part.
      var list = document.getElementById('cafe-list');
      cafes.forEach(function (c) {
        list.appendChild(details(c, document.createElement('li')));
      });

      // MapLibre is only fetched once there is something to put on it. The
      // page names the file, so its URL carries the same version as the rest.
      var el = document.getElementById('map');
      return import(el.getAttribute('data-lib'))
        .then(function (maplibregl) { draw(maplibregl, cafes); })
        .catch(function () {
          sub.textContent = count + ' The map could not be drawn just now.';
          hideMap();
        });
    })
    .catch(function () {
      document.getElementById('map-sub').textContent =
        'The map could not be loaded just now.';
      hideMap();
    });

  function draw(maplibregl, cafes) {
    // OpenFreeMap: OpenStreetMap data, no key, no account, no cookies. The
    // style carries its own attribution, which MapLibre shows on the map.
    var map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [cafes[0].lng, cafes[0].lat],
      zoom: 11,
      maxZoom: 19,
      // A flat map of pins has nothing to gain from tilting or turning.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // The page scrolls; the wheel should scroll it. Clicking the map says
    // "I mean this one", and then the wheel zooms.
    map.scrollZoom.disable();
    map.on('click', function () { map.scrollZoom.enable(); });
    map.on('mouseout', function () { map.scrollZoom.disable(); });

    var bounds = new maplibregl.LngLatBounds();
    cafes.forEach(function (c, i) {
      bounds.extend([c.lng, c.lat]);
      var pin = document.createElement('span');
      pin.className = 'pin';
      pin.textContent = String(i + 1);
      pin.title = c.name || 'A repair café';
      // Out of the tab order: the list beside the map says the same thing
      // and is far easier to reach with a keyboard.
      pin.setAttribute('tabindex', '-1');
      // Leaflet's width, and no jump of focus to the link inside: the pins
      // are for the mouse, and the list is the way in for a keyboard.
      var popup = new maplibregl.Popup({ offset: 16, maxWidth: '300px', focusAfterOpen: false })
        .setDOMContent(details(c, document.createElement('div')));
      popup.on('open', function () { makeRoom(map, popup); });
      new maplibregl.Marker({ element: pin })
        .setLngLat([c.lng, c.lat])
        .setPopup(popup)
        .addTo(map);
    });

    if (cafes.length > 1) {
      map.fitBounds(bounds, { padding: 40, maxZoom: 12, animate: false });
    }
  }

  /** Leaflet panned a popup into view and MapLibre does not, so a pin near
   *  the edge opened half off the map. The credits start out open, and on a
   *  phone they cover most of a popup; they fold to their ⓘ while one is
   *  open, and the footer names them too. */
  function makeRoom(map, popup) {
    var credits = map.getContainer().querySelector('.maplibregl-compact-show .maplibregl-ctrl-attrib-button');
    if (credits) credits.click();

    var m = map.getContainer().getBoundingClientRect();
    var p = popup.getElement().getBoundingClientRect();
    var gap = 10;
    var dx = 0;
    var dy = 0;
    if (p.top < m.top + gap) dy = p.top - m.top - gap;
    else if (p.bottom > m.bottom - gap) dy = p.bottom - m.bottom + gap;
    if (p.left < m.left + gap) dx = p.left - m.left - gap;
    else if (p.right > m.right - gap) dx = p.right - m.right + gap;
    if (dx || dy) map.panBy([dx, dy]);
  }
})();
