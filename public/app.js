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
        document.getElementById('map').style.display = 'none';
        return;
      }
      sub.textContent =
        cafes.length === 1
          ? 'One café has asked to appear here. Click the pin for its numbers.'
          : cafes.length + ' cafés have asked to appear here. Click a pin for its numbers.';

      var map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(map);
      // The page scrolls; the wheel should scroll it. Clicking the map says
      // "I mean this one", and then the wheel zooms.
      map.on('click', function () { map.scrollWheelZoom.enable(); });
      map.on('mouseout', function () { map.scrollWheelZoom.disable(); });

      var bounds = [];
      var list = document.getElementById('cafe-list');

      cafes.forEach(function (c, i) {
        bounds.push([c.lat, c.lng]);
        var marker = L.marker([c.lat, c.lng], {
          icon: L.divIcon({
            className: '',
            html: '<span class="pin">' + (i + 1) + '</span>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
          }),
          title: c.name || 'A repair café',
          keyboard: false
        }).addTo(map);

        var name = document.createElement('b');
        name.textContent = c.name || 'A repair café';
        var facts = document.createElement('span');
        facts.textContent =
          nf.format(c.repairsFixed) + ' fixed · ' +
          nf.format(c.sessionsHeld) + ' sessions · ' +
          weight(c.co2SavedKg) + ' saved';

        // Built as nodes rather than markup, so a café name can never be read
        // as HTML. The name comes from a public directory, but that is no
        // reason to hand it a script tag.
        var popup = document.createElement('div');
        popup.appendChild(name.cloneNode(true));
        popup.appendChild(facts.cloneNode(true));
        if (c.url) {
          var a = document.createElement('a');
          a.href = c.url;
          a.textContent = 'Visit their site';
          a.rel = 'noopener';
          a.target = '_blank';
          popup.appendChild(document.createElement('br'));
          popup.appendChild(a);
        }
        marker.bindPopup(popup);

        var li = document.createElement('li');
        li.appendChild(name);
        li.appendChild(facts);
        if (c.url) {
          var a2 = document.createElement('a');
          a2.href = c.url;
          a2.textContent = 'Visit their site';
          a2.rel = 'noopener';
          a2.target = '_blank';
          li.appendChild(document.createElement('br'));
          li.appendChild(a2);
        }
        list.appendChild(li);
      });

      if (bounds.length === 1) map.setView(bounds[0], 11);
      else map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    })
    .catch(function () {
      document.getElementById('map-sub').textContent =
        'The map could not be loaded just now.';
      document.getElementById('map').style.display = 'none';
    });
})();
