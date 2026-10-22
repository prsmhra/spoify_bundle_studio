/**
 * Build Your Own Masala Mix — section behaviour
 * ----------------------------------------------------------------------
 * Vanilla JS, no dependencies. Implements a <masala-bundle-builder> custom
 * element so the section is self-initialising, safely re-initialises when
 * Shopify's theme editor hot-reloads the section, and never touches global
 * selectors outside of a small, explicitly feature-detected set used only
 * for best-effort host-theme cart UI refresh (cart icon bubble / drawer).
 *
 * Bundle architecture: every selected spice is added to the Shopify cart as
 * its own real variant line item via POST /cart/add.js (Option A). Nothing
 * here fabricates a bundle product or assumes component inventory deduction.
 */
(function () {
  'use strict';

  if (window.customElements && window.customElements.get('masala-bundle-builder')) {
    return;
  }

  /** Mirrors Shopify Dawn's pub/sub event name constants, used only if the
   *  host theme actually exposes a compatible global subscribe/publish. */
  var PUB_SUB_EVENTS = {
    cartUpdate: 'cart-update',
    cartError: 'cart-error',
  };

  var WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|g)\b/i;

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(ctx, args);
      }, wait);
    };
  }

  function clamp(value, min, max) {
    value = Number(value) || 0;
    if (typeof min === 'number' && value < min) value = min;
    if (typeof max === 'number' && max > 0 && value > max) value = max;
    return value;
  }

  /** Parses a weight option value like "10 g" / "1 kg" into whole grams. */
  function parseWeightGrams(label) {
    if (!label) return 0;
    var match = String(label).match(WEIGHT_PATTERN);
    if (!match) return 0;
    var amount = parseFloat(match[1]);
    var unit = match[2].toLowerCase();
    if (unit === 'kg') amount *= 1000;
    return Math.round(amount);
  }

  function formatWeight(grams) {
    grams = Number(grams) || 0;
    if (grams <= 0) return '0 g';
    if (grams >= 1000) {
      var kg = grams / 1000;
      var rounded = Math.round(kg * 100) / 100;
      return (rounded % 1 === 0 ? rounded.toFixed(0) : String(rounded)) + ' kg';
    }
    return grams + ' g';
  }

  /** Formats integer currency subunits using Intl, matching Shopify's own
   *  normalisation (money values are always expressed in hundredths). */
  function formatMoney(cents, currencyCode, locale) {
    var amount = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: 'currency',
        currency: currencyCode || 'USD',
      }).format(amount);
    } catch (err) {
      return amount.toFixed(2);
    }
  }

  var STORAGE_PREFIX = 'mbb:saved-blend:';

  /**
   * <masala-bundle-builder> encapsulates one section instance end-to-end.
   * All queries are scoped to `this` (never bare `document`) except the
   * explicitly feature-detected, best-effort host-theme cart refresh hooks.
   */
  class MasalaBundleBuilder extends HTMLElement {
    connectedCallback() {
      if (this._mbbInitialised) return;
      this._mbbInitialised = true;

      var el = this;
      var ds = el.dataset;

      el.config = {
        sectionId: ds.sectionId || '',
        currency: ds.currency || 'USD',
        locale: ds.locale || undefined,
        pricingStrategy: ds.pricingStrategy || 'sum',
        fixedPriceCents: parseInt(ds.fixedPriceCents, 10) || 0,
        weightPricePerUnitCents: parseInt(ds.weightPricePerUnitCents, 10) || 0,
        weightPriceUnitGrams: parseInt(ds.weightPriceUnitGrams, 10) || 100,
        minWeight: parseInt(ds.minWeight, 10) || 0,
        maxWeight: parseInt(ds.maxWeight, 10) || 0,
        minCount: parseInt(ds.minCount, 10) || 0,
        maxCount: parseInt(ds.maxCount, 10) || 0,
        resetConfirmThreshold: parseInt(ds.resetConfirmThreshold, 10) || 0,
        stickySummary: ds.stickySummary === 'true',
        sectionUrl: ds.sectionUrl || window.location.pathname,
        totalPages: parseInt(ds.totalPages, 10) || 1,
        showLoadMore: ds.showLoadMore === 'true',
      };

      el.products = {}; // productId -> product data
      el.selections = {}; // productId -> selection record
      el.cardElements = {}; // productId -> card DOM element (for summary-driven updates)
      el.currentPage = 1;
      el.isAddingToCart = false;
      el.isLoadingMore = false;
      el.searchTerm = '';

      el.refs = {
        grid: el.querySelector('[data-mbb-grid]'),
        searchInput: el.querySelector('[data-mbb-search-input]'),
        searchClear: el.querySelector('[data-mbb-search-clear]'),
        loadMoreBtn: el.querySelector('[data-mbb-load-more]'),
        loadMoreLabel: el.querySelector('[data-mbb-load-more-label]'),
        loadMoreSpinner: el.querySelector('[data-mbb-load-more-spinner]'),
        summaryList: el.querySelector('[data-mbb-summary-list]'),
        summaryEmpty: el.querySelector('[data-mbb-summary-empty]'),
        lineTemplate: el.querySelector('[data-mbb-line-item-template]'),
        totalWeight: el.querySelector('[data-mbb-total-weight]'),
        remainingWeight: el.querySelector('[data-mbb-remaining-weight]'),
        progressBar: el.querySelector('[data-mbb-progress-bar]'),
        totalPrice: el.querySelector('[data-mbb-total-price]'),
        priceNote: el.querySelector('[data-mbb-price-note]'),
        addToCartBtn: el.querySelector('[data-mbb-add-to-cart]'),
        addToCartLabel: el.querySelector('[data-mbb-add-to-cart-label]'),
        addToCartSpinner: el.querySelector('[data-mbb-add-to-cart-spinner]'),
        saveBlendBtn: el.querySelector('[data-mbb-save-blend]'),
        savedNote: el.querySelector('[data-mbb-saved-note]'),
        resetBtn: el.querySelector('[data-mbb-reset-all]'),
        status: el.querySelector('[data-mbb-status]'),
        errorStatus: el.querySelector('[data-mbb-error-status]'),
      };

      el._parseCardsIn(el.refs.grid);
      el._bindGlobalControls();
      el._renderSummary();
      el._maybeOfferSavedBlend();
    }

    disconnectedCallback() {
      this._mbbInitialised = false;
    }

    /** Parses every not-yet-seen product card inside `container`, storing
     *  its JSON data and wiring up its interactive controls. Safe to call
     *  again after Load More appends new cards. */
    _parseCardsIn(container) {
      var el = this;
      if (!container) return;
      var cards = container.querySelectorAll('[data-mbb-product-card]');
      cards.forEach(function (card) {
        if (card.dataset.mbbBound === 'true') return;
        var dataScript = card.querySelector('[data-mbb-product-data]');
        if (!dataScript) return;
        var data;
        try {
          data = JSON.parse(dataScript.textContent);
        } catch (err) {
          return;
        }
        data.variants = (data.variants || []).map(function (variant) {
          return Object.assign({}, variant, {
            weightGrams: variant.weightLabel ? parseWeightGrams(variant.weightLabel) : 0,
          });
        });
        el.products[String(data.id)] = data;
        el._bindCard(card, data);
        card.dataset.mbbBound = 'true';
      });
    }


    /** Wires up one product card's weight pills, quantity stepper and Add
     *  button. Card-local "staged" state (which variant / qty is currently
     *  chosen before the shopper presses Add) lives on the card element
     *  itself via a WeakMap-free plain property, keeping each card
     *  self-contained. */
    _bindCard(card, product) {
      var el = this;
      el.cardElements[String(product.id)] = card;
      var hasWeights = product.weightOptionIndex > -1 && product.variants.some(function (v) { return v.weightLabel; });
      var defaultVariant = product.variants.find(function (v) { return v.available; }) || product.variants[0];

      card._mbbStaged = {
        variantId: defaultVariant ? defaultVariant.id : null,
        weightLabel: defaultVariant ? defaultVariant.weightLabel : null,
        quantity: 1,
      };

      var qtyWrap = card.querySelector('[data-mbb-card-qty]');
      var qtyValueEl = card.querySelector('[data-mbb-card-qty-value]');
      var addBtn = card.querySelector('[data-mbb-add-btn]');
      var addBtnLabel = card.querySelector('[data-mbb-add-btn-label]');
      var addBtnSpinner = card.querySelector('[data-mbb-add-btn-spinner]');
      var addedBadge = card.querySelector('[data-mbb-added-badge]');

      function syncAddedVisualState() {
        var existing = el.selections[String(product.id)];
        card.classList.toggle('mbb-card--added', !!existing);
        if (addedBadge) el._setHidden(addedBadge, !existing);
        if (addBtnLabel && product.available) {
          addBtnLabel.textContent = existing ? 'Update' : 'Add';
        }
      }

      if (qtyWrap && !hasWeights) {
        var decBtn = qtyWrap.querySelector('[data-mbb-card-qty-decrease]');
        var incBtn = qtyWrap.querySelector('[data-mbb-card-qty-increase]');
        decBtn.addEventListener('click', function () {
          card._mbbStaged.quantity = clamp(card._mbbStaged.quantity - 1, 1, 0);
          qtyValueEl.textContent = String(card._mbbStaged.quantity);
        });
        incBtn.addEventListener('click', function () {
          card._mbbStaged.quantity = clamp(card._mbbStaged.quantity + 1, 1, 99);
          qtyValueEl.textContent = String(card._mbbStaged.quantity);
        });
      }

      if (hasWeights) {
        var pills = card.querySelectorAll('[data-mbb-weight-pill]');
        pills.forEach(function (pill) {
          pill.addEventListener('click', function () {
            if (pill.disabled) return;
            pills.forEach(function (p) { p.setAttribute('aria-pressed', 'false'); });
            pill.setAttribute('aria-pressed', 'true');
            card._mbbStaged.variantId = parseInt(pill.dataset.variantId, 10);
            card._mbbStaged.weightLabel = pill.dataset.weightLabel;
            // Weight pills select a *different variant line*, not a repeat
            // purchase of the same line, so quantity resets to 1 here.
            card._mbbStaged.quantity = 1;

            // If that specific variant is already in the bundle, reflect
            // its live quantity instead of forcing it back to one.
            var selectionKey = String(product.id);
            var existing = el.selections[selectionKey];
            if (existing && existing.variantId === card._mbbStaged.variantId) {
              card._mbbStaged.quantity = existing.quantity;
            }
          });
        });
      }

      if (addBtn) {
        addBtn.addEventListener('click', function () {
          if (addBtn.disabled || addBtn.dataset.mbbBusy === 'true') return;
          addBtn.dataset.mbbBusy = 'true';
          addBtn.disabled = true;
          addBtn.setAttribute('aria-busy', 'true');
          if (addBtnSpinner) el._setHidden(addBtnSpinner, false);

          window.setTimeout(function () {
            el._upsertSelection(product, card._mbbStaged);
            syncAddedVisualState();
            addBtn.dataset.mbbBusy = 'false';
            addBtn.disabled = !product.available;
            addBtn.removeAttribute('aria-busy');
            if (addBtnSpinner) el._setHidden(addBtnSpinner, true);
            el._renderSummary();
            el._announce(product.title + ' added to your masala mix.');
          }, 120);
        });
      }

      syncAddedVisualState();
    }


    /** Adds a product to the bundle, or updates its existing line's variant
     *  and quantity instead of creating a duplicate entry (per spec: each
     *  product appears only once as a bundle line item). */
    _upsertSelection(product, staged) {
      var el = this;
      var key = String(product.id);
      var variant = product.variants.find(function (v) { return v.id === staged.variantId; }) || product.variants[0];
      if (!variant) return;

      // Enforce max product count only when adding a brand-new line.
      if (!el.selections[key]) {
        var atMaxCount = el.config.maxCount > 0 && Object.keys(el.selections).length >= el.config.maxCount;
        if (atMaxCount) {
          el._announceError('You can select up to ' + el.config.maxCount + ' products in this bundle.');
          return;
        }
      }

      var nextQuantity = Math.max(1, staged.quantity || 1);

      // Enforce max bundle weight by capping the quantity that would push
      // the running total over the configured ceiling (if the product has
      // a weight dimension at all).
      if (el.config.maxWeight > 0 && variant.weightGrams > 0) {
        var weightWithoutThisLine = el._totalWeight(key);
        var maxUnitsAllowed = Math.floor((el.config.maxWeight - weightWithoutThisLine) / variant.weightGrams);
        if (maxUnitsAllowed < 1) {
          el._announceError('Adding this would exceed the maximum bundle weight of ' + formatWeight(el.config.maxWeight) + '.');
          return;
        }
        nextQuantity = Math.min(nextQuantity, maxUnitsAllowed);
      }

      el.selections[key] = {
        productId: product.id,
        title: product.title,
        image: product.image,
        variantId: variant.id,
        weightLabel: variant.weightLabel,
        weightGrams: variant.weightGrams || 0,
        price: variant.price || 0,
        quantity: nextQuantity,
        available: variant.available,
      };
    }

    /** Running total weight (grams) across all selections, optionally
     *  excluding one product key (used to check headroom before adding
     *  more of that same product). */
    _totalWeight(excludeKey) {
      var el = this;
      var total = 0;
      Object.keys(el.selections).forEach(function (key) {
        if (key === excludeKey) return;
        var sel = el.selections[key];
        total += (sel.weightGrams || 0) * sel.quantity;
      });
      return total;
    }

    _totalSelectedCount() {
      return Object.keys(this.selections).length;
    }

    /** Sum of real variant price * quantity across all selections, in
     *  integer currency subunits — this is always the true checkout total
     *  under the Option A architecture used here. */
    _totalRealPriceCents() {
      var el = this;
      var total = 0;
      Object.keys(el.selections).forEach(function (key) {
        var sel = el.selections[key];
        total += (sel.price || 0) * sel.quantity;
      });
      return total;
    }

    /** Resolves the price to actually DISPLAY as "Total price" based on the
     *  merchant's configured pricing strategy. Fixed/weight-based values
     *  are always labelled as estimates by _renderSummary(), because the
     *  real checkout charge is always the sum of selected variant prices. */
    _displayedPriceCents() {
      var el = this;
      var realSum = el._totalRealPriceCents();
      if (el.config.pricingStrategy === 'fixed' && el._totalSelectedCount() > 0) {
        return el.config.fixedPriceCents;
      }
      if (el.config.pricingStrategy === 'weight_based' && el._totalSelectedCount() > 0) {
        var unit = el.config.weightPriceUnitGrams || 100;
        var units = el._totalWeight(null) / unit;
        return Math.round(units * el.config.weightPricePerUnitCents);
      }
      return realSum;
    }

    _removeSelection(productKey) {
      var el = this;
      delete el.selections[productKey];
      var card = el.cardElements[productKey];
      if (card) {
        card.classList.remove('mbb-card--added');
        var addedBadge = card.querySelector('[data-mbb-added-badge]');
        if (addedBadge) el._setHidden(addedBadge, true);
        var addBtnLabel = card.querySelector('[data-mbb-add-btn-label]');
        if (addBtnLabel && card.querySelector('[data-mbb-add-btn]') && !card.querySelector('[data-mbb-add-btn]').disabled) {
          addBtnLabel.textContent = 'Add';
        }
      }
    }

    _setLineQuantity(productKey, nextQuantity) {
      var el = this;
      var sel = el.selections[productKey];
      if (!sel) return;
      if (nextQuantity < 1) {
        el._removeSelection(productKey);
        el._renderSummary();
        return;
      }
      if (el.config.maxWeight > 0 && sel.weightGrams > 0) {
        var othersWeight = el._totalWeight(productKey);
        var maxUnits = Math.floor((el.config.maxWeight - othersWeight) / sel.weightGrams);
        if (nextQuantity > maxUnits) {
          el._announceError('That would exceed the maximum bundle weight of ' + formatWeight(el.config.maxWeight) + '.');
          return;
        }
      }
      sel.quantity = nextQuantity;
      el._renderSummary();
    }


    /** Rebuilds the entire right-hand summary panel from `this.selections`.
     *  Called after every add/remove/quantity change so the UI "updates
     *  instantly" as required. Uses the <template> line-item markup so the
     *  HTML structure lives in Liquid, not duplicated in JS strings. */
    _renderSummary() {
      var el = this;
      var refs = el.refs;
      var keys = Object.keys(el.selections);

      if (refs.summaryEmpty) el._setHidden(refs.summaryEmpty, keys.length > 0);

      if (refs.summaryList && refs.lineTemplate) {
        refs.summaryList.querySelectorAll('[data-mbb-line-item]').forEach(function (node) {
          node.remove();
        });

        keys.forEach(function (key) {
          var sel = el.selections[key];
          var node = refs.lineTemplate.content.firstElementChild.cloneNode(true);
          node.dataset.productId = key;

          var img = node.querySelector('[data-mbb-line-image]');
          if (img) {
            img.src = sel.image || '';
            img.alt = sel.title || '';
          }
          var titleEl = node.querySelector('[data-mbb-line-title]');
          if (titleEl) titleEl.textContent = sel.title;

          var metaEl = node.querySelector('[data-mbb-line-meta]');
          if (metaEl) {
            metaEl.textContent = sel.weightLabel ? sel.weightLabel + ' × ' + sel.quantity : 'Qty ' + sel.quantity;
          }

          var qtyValueEl = node.querySelector('[data-mbb-line-qty-value]');
          if (qtyValueEl) qtyValueEl.textContent = String(sel.quantity);

          var priceEl = node.querySelector('[data-mbb-line-price]');
          if (priceEl) priceEl.textContent = formatMoney(sel.price * sel.quantity, el.config.currency, el.config.locale);

          var decBtn = node.querySelector('[data-mbb-line-decrease]');
          var incBtn = node.querySelector('[data-mbb-line-increase]');
          var removeBtn = node.querySelector('[data-mbb-line-remove]');
          if (decBtn) decBtn.addEventListener('click', function () { el._setLineQuantity(key, sel.quantity - 1); });
          if (incBtn) incBtn.addEventListener('click', function () { el._setLineQuantity(key, sel.quantity + 1); });
          if (removeBtn) {
            removeBtn.setAttribute('aria-label', 'Remove ' + sel.title);
            removeBtn.addEventListener('click', function () {
              el._removeSelection(key);
              el._renderSummary();
              el._announce(sel.title + ' removed from your masala mix.');
            });
          }

          refs.summaryList.appendChild(node);
        });
      }

      var totalWeight = el._totalWeight(null);
      if (refs.totalWeight) refs.totalWeight.textContent = formatWeight(totalWeight);

      if (refs.remainingWeight && el.config.maxWeight > 0) {
        var remaining = Math.max(0, el.config.maxWeight - totalWeight);
        refs.remainingWeight.textContent = formatWeight(remaining);
        var row = refs.remainingWeight.closest('.mbb-summary__weight-row');
        if (row) row.classList.toggle('mbb-summary__weight-row--over', remaining <= 0 && totalWeight > 0);
      }

      if (refs.progressBar && el.config.maxWeight > 0) {
        var pct = Math.min(100, Math.round((totalWeight / el.config.maxWeight) * 100));
        refs.progressBar.style.width = pct + '%';
        refs.progressBar.classList.toggle('mbb-progress__bar--over', totalWeight > el.config.maxWeight);
      }

      var displayedCents = el._displayedPriceCents();
      if (refs.totalPrice) refs.totalPrice.textContent = formatMoney(displayedCents, el.config.currency, el.config.locale);

      if (refs.priceNote) {
        var isEstimateStrategy = el.config.pricingStrategy === 'fixed' || el.config.pricingStrategy === 'weight_based';
        if (isEstimateStrategy && keys.length > 0) {
          var realSum = el._totalRealPriceCents();
          refs.priceNote.textContent = 'Estimated price. Your card is charged the sum of the individual spice prices: ' +
            formatMoney(realSum, el.config.currency, el.config.locale) + '.';
          el._setHidden(refs.priceNote, false);
        } else {
          el._setHidden(refs.priceNote, true);
        }
      }

      el._updateAddToCartState(keys.length, totalWeight);
    }

    /** Enables/disables the Add to Cart button based on the merchant's
     *  configured minimum selection rules (count + weight). Maximums are
     *  enforced proactively at selection-time, so only minimums need to
     *  gate the button itself. */
    _updateAddToCartState(selectedCount, totalWeight) {
      var el = this;
      if (!el.refs.addToCartBtn) return;
      var meetsCount = selectedCount > 0 && (el.config.minCount === 0 || selectedCount >= el.config.minCount);
      var meetsWeight = el.config.minWeight === 0 || totalWeight >= el.config.minWeight;
      var isValid = meetsCount && meetsWeight;
      el.refs.addToCartBtn.disabled = !isValid;
      el.refs.addToCartBtn.setAttribute('aria-disabled', String(!isValid));
    }


    /** Small shared UI helpers kept on the instance so every method above
     *  can call them without reaching for bare globals. */
    _setHidden(node, hidden) {
      if (!node) return;
      node.classList.toggle('mbb-visually-hidden', hidden);
      node.classList.toggle('mbb-status--visible', !hidden && node.classList.contains('mbb-status'));
    }

    _announce(message) {
      var el = this;
      if (!el.refs.status) return;
      el.refs.status.textContent = message;
      el._setHidden(el.refs.status, false);
      window.clearTimeout(el._statusTimer);
      el._statusTimer = window.setTimeout(function () {
        el._setHidden(el.refs.status, true);
      }, 4000);
    }

    _announceError(message) {
      var el = this;
      if (!el.refs.errorStatus) return;
      el.refs.errorStatus.textContent = message;
      el._setHidden(el.refs.errorStatus, false);
      window.clearTimeout(el._errorTimer);
      el._errorTimer = window.setTimeout(function () {
        el._setHidden(el.refs.errorStatus, true);
      }, 6000);
    }

    /** Wires up controls that exist once per section instance: search,
     *  load more, add to cart, save blend and reset all. */
    _bindGlobalControls() {
      var el = this;
      var refs = el.refs;

      if (refs.searchInput) {
        var applySearch = debounce(function () {
          el.searchTerm = refs.searchInput.value.trim().toLowerCase();
          el._applySearchFilter();
          if (refs.searchClear) el._setHidden(refs.searchClear, el.searchTerm.length === 0);
        }, 150);
        refs.searchInput.addEventListener('input', applySearch);
      }

      if (refs.searchClear) {
        refs.searchClear.addEventListener('click', function () {
          refs.searchInput.value = '';
          el.searchTerm = '';
          el._applySearchFilter();
          el._setHidden(refs.searchClear, true);
          refs.searchInput.focus();
        });
      }

      if (refs.loadMoreBtn) {
        if (refs.loadMoreLabel) {
          refs.loadMoreBtn.dataset.originalLabel = refs.loadMoreLabel.textContent;
        }
        refs.loadMoreBtn.addEventListener('click', function () {
          el._loadMoreProducts();
        });
      }

      if (refs.addToCartBtn) {
        refs.addToCartBtn.addEventListener('click', function () {
          el._handleAddToCart();
        });
      }

      if (refs.saveBlendBtn) {
        refs.saveBlendBtn.addEventListener('click', function () {
          el._saveBlend();
        });
      }

      if (refs.resetBtn) {
        refs.resetBtn.addEventListener('click', function () {
          el._handleResetAll();
        });
      }
    }

    /** Filters already-rendered product cards by title, client-side, across
     *  every card loaded so far (initial render + any "Load More" pages).
     *  This does not query the full store catalogue beyond what has been
     *  loaded into the DOM. */
    _applySearchFilter() {
      var el = this;
      if (!el.refs.grid) return;
      var term = el.searchTerm;
      var cards = el.refs.grid.querySelectorAll('[data-mbb-product-card]');
      var visibleCount = 0;
      cards.forEach(function (card) {
        var title = (card.dataset.productTitle || '').toLowerCase();
        var matches = term === '' || title.indexOf(term) > -1;
        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount += 1;
      });
      el._toggleEmptyGridMessage(visibleCount === 0);
    }

    _toggleEmptyGridMessage(show) {
      var el = this;
      if (!el.refs.grid) return;
      var existing = el.refs.grid.querySelector('[data-mbb-search-empty]');
      if (show && !existing) {
        var empty = document.createElement('div');
        empty.className = 'mbb-grid__empty';
        empty.setAttribute('data-mbb-search-empty', '');
        empty.textContent = 'No spices match your search.';
        el.refs.grid.appendChild(empty);
      } else if (!show && existing) {
        existing.remove();
      }
    }


    /** Fetches the next page of the configured collection using Shopify's
     *  Section Rendering API (?section_id=…&page=N), which re-renders this
     *  exact section — including the real product-card Liquid/metafield
     *  markup — for that page, and splices the newly returned cards into
     *  the live grid. No fake or client-fabricated product data is used. */
    _loadMoreProducts() {
      var el = this;
      if (el.isLoadingMore) return;
      if (el.currentPage >= el.config.totalPages) return;

      el.isLoadingMore = true;
      var nextPage = el.currentPage + 1;
      var btn = el.refs.loadMoreBtn;
      if (btn) btn.disabled = true;
      if (el.refs.loadMoreSpinner) el._setHidden(el.refs.loadMoreSpinner, false);
      if (el.refs.loadMoreLabel) el.refs.loadMoreLabel.textContent = 'Loading…';

      var base = el.config.sectionUrl || window.location.pathname;
      var separator = base.indexOf('?') > -1 ? '&' : '?';
      var url = base + separator + 'page=' + nextPage + '&section_id=' + encodeURIComponent(el.config.sectionId);

      fetch(url, { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('Request failed with status ' + response.status);
          return response.text();
        })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var newGrid = doc.querySelector('[data-mbb-grid]');
          var newCards = newGrid ? newGrid.querySelectorAll('[data-mbb-product-card]') : [];
          if (!newCards.length) {
            el._hideLoadMore();
            return;
          }
          newCards.forEach(function (card) {
            el.refs.grid.appendChild(document.importNode(card, true));
          });
          el._parseCardsIn(el.refs.grid);
          el.currentPage = nextPage;
          if (el.searchTerm) el._applySearchFilter();
          if (el.currentPage >= el.config.totalPages) el._hideLoadMore();
        })
        .catch(function () {
          el._announceError('We couldn\'t load more spices. Please try again.');
        })
        .finally(function () {
          el.isLoadingMore = false;
          if (btn) btn.disabled = false;
          if (el.refs.loadMoreSpinner) el._setHidden(el.refs.loadMoreSpinner, true);
          if (el.refs.loadMoreLabel && el.currentPage < el.config.totalPages) {
            el.refs.loadMoreLabel.textContent = btn ? (btn.dataset.originalLabel || 'Load More Spices') : 'Load More Spices';
          }
        });
    }

    _hideLoadMore() {
      if (this.refs.loadMoreBtn) this._setHidden(this.refs.loadMoreBtn.parentElement, true);
    }


    /** Validates the current selection against configured bundle rules,
     *  then adds every selected spice variant to the Shopify cart as its
     *  own line item via POST /cart/add.js (Option A architecture). */
    _handleAddToCart() {
      var el = this;
      if (el.isAddingToCart) return;

      var keys = Object.keys(el.selections);
      if (keys.length === 0) {
        el._announceError('Please select at least one spice before adding to your cart.');
        return;
      }

      var totalWeight = el._totalWeight(null);
      if (el.config.minCount > 0 && keys.length < el.config.minCount) {
        el._announceError('Please select at least ' + el.config.minCount + ' products for this bundle.');
        return;
      }
      if (el.config.minWeight > 0 && totalWeight < el.config.minWeight) {
        el._announceError('Your bundle must weigh at least ' + formatWeight(el.config.minWeight) + '.');
        return;
      }
      if (el.config.maxWeight > 0 && totalWeight > el.config.maxWeight) {
        el._announceError('Your bundle exceeds the maximum weight of ' + formatWeight(el.config.maxWeight) + '.');
        return;
      }

      var unavailable = keys.filter(function (key) { return !el.selections[key].available; });
      if (unavailable.length > 0) {
        el._announceError('Some selected spices are sold out. Please remove them before adding to your cart.');
        return;
      }

      var items = keys.map(function (key) {
        var sel = el.selections[key];
        return {
          id: sel.variantId,
          quantity: sel.quantity,
          properties: {
            _masala_mix: 'Build Your Own Masala Mix',
          },
        };
      });

      el.isAddingToCart = true;
      el._setButtonBusy(el.refs.addToCartBtn, el.refs.addToCartLabel, el.refs.addToCartSpinner, true, 'Adding…');

      var cartRoot = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

      fetch(cartRoot + 'cart/add.js', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: items }),
      })
        .then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) {
              var message = (body && (body.description || body.message)) || 'Something went wrong while adding your bundle to the cart.';
              throw new Error(message);
            }
            return body;
          });
        })
        .then(function () {
          el._announce('Your masala mix was added to your cart.');
          el._refreshCartUi();
          el.dispatchEvent(new CustomEvent('mbb:added-to-cart', { bubbles: true, detail: { items: items } }));
        })
        .catch(function (err) {
          el._announceError(err && err.message ? err.message : 'We could not add your bundle to the cart. Please try again.');
        })
        .finally(function () {
          el.isAddingToCart = false;
          el._setButtonBusy(el.refs.addToCartBtn, el.refs.addToCartLabel, el.refs.addToCartSpinner, false, el.refs.addToCartBtn ? (el.refs.addToCartBtn.dataset.originalLabel || 'Add to Cart') : 'Add to Cart');
          el._updateAddToCartState(Object.keys(el.selections).length, el._totalWeight(null));
        });
    }

    _setButtonBusy(btn, labelEl, spinnerEl, busy, labelText) {
      if (!btn) return;
      if (busy && !btn.dataset.originalLabel && labelEl) {
        btn.dataset.originalLabel = labelEl.textContent;
      }
      btn.disabled = busy;
      if (busy) btn.setAttribute('aria-busy', 'true');
      else btn.removeAttribute('aria-busy');
      if (labelEl && labelText) labelEl.textContent = labelText;
      if (spinnerEl) this._setHidden(spinnerEl, !busy);
    }

    /** Best-effort refresh of the host theme's cart icon / drawer. Every
     *  lookup here is feature-detected; nothing throws or breaks if the
     *  theme doesn't expose these hooks, and this section remains fully
     *  functional (cart was already updated server-side) regardless. */
    _refreshCartUi() {
      var el = this;

      // 1) Generic DOM event any theme/app can listen for.
      document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true }));

      // 2) Dawn-compatible pub/sub, only if the theme actually exposes the
      //    global subscribe/publish functions (Dawn's constants.js defines
      //    PUB_SUB_EVENTS with `const`, so it is never attached to
      //    `window` — we pass the verified literal event name instead of
      //    depending on a `window.PUB_SUB_EVENTS` lookup that would always
      //    be undefined, even on genuine Dawn-based themes).
      if (typeof window.publish === 'function') {
        try {
          window.publish(PUB_SUB_EVENTS.cartUpdate, { source: 'masala-bundle-builder' });
        } catch (err) {
          /* no-op: best effort only */
        }
      }

      // 3) Refresh a cart item-count bubble if the theme exposes one, using
      //    a plain /cart.js read so counts stay correct without guessing at
      //    the host theme's section HTML structure.
      fetch((window.Shopify && window.Shopify.routes && window.Shopify.routes.root || '/') + 'cart.js', {
        credentials: 'same-origin',
      })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (cart) {
          if (!cart) return;
          document.querySelectorAll('[data-cart-count], [data-mbb-cart-count]').forEach(function (node) {
            node.textContent = cart.item_count;
          });
        })
        .catch(function () {
          /* no-op: best effort only */
        });
    }


    /** Saves the current selection to this browser's localStorage, keyed
     *  per section instance. This is explicitly a DEVICE-LOCAL convenience,
     *  not a permanent or cross-device customer storage mechanism — no such
     *  backend exists in this implementation, matching the merchant's
     *  chosen fallback behaviour for guest/no-account shoppers. */
    _saveBlend() {
      var el = this;
      var keys = Object.keys(el.selections);
      if (keys.length === 0) {
        el._announceError('Add some spices to your mix before saving a blend.');
        return;
      }
      try {
        var payload = {
          savedAt: new Date().toISOString(),
          selections: el.selections,
        };
        window.localStorage.setItem(STORAGE_PREFIX + el.config.sectionId, JSON.stringify(payload));
        if (el.refs.savedNote) {
          el.refs.savedNote.textContent = 'Blend saved on this device. It will be offered again next time you visit this browser.';
          el._setHidden(el.refs.savedNote, false);
          window.clearTimeout(el._savedNoteTimer);
          el._savedNoteTimer = window.setTimeout(function () {
            el._setHidden(el.refs.savedNote, true);
          }, 6000);
        }
        el._announce('Your blend was saved on this device.');
      } catch (err) {
        el._announceError('We could not save your blend on this device. Your browser storage may be full or disabled.');
      }
    }

    /** On load, if a previously saved device-local blend exists for this
     *  section, offers to restore it rather than auto-applying it silently
     *  (so shoppers are never surprised by pre-filled selections). */
    _maybeOfferSavedBlend() {
      var el = this;
      var raw;
      try {
        raw = window.localStorage.getItem(STORAGE_PREFIX + el.config.sectionId);
      } catch (err) {
        return;
      }
      if (!raw) return;

      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return;
      }
      if (!parsed || !parsed.selections) return;

      var restore = window.confirm('We found a masala mix you saved earlier on this device. Would you like to restore it?');
      if (!restore) return;

      Object.keys(parsed.selections).forEach(function (key) {
        var saved = parsed.selections[key];
        var product = el.products[key];
        if (!product) return; // product no longer loaded/available on this page
        var variant = product.variants.find(function (v) { return v.id === saved.variantId; });
        if (!variant || !variant.available) return;
        el.selections[key] = Object.assign({}, saved, {
          price: variant.price,
          available: variant.available,
        });
        var card = el.cardElements[key];
        if (card) {
          card.classList.add('mbb-card--added');
          var addedBadge = card.querySelector('[data-mbb-added-badge]');
          if (addedBadge) el._setHidden(addedBadge, false);
        }
      });
      el._renderSummary();
    }

    /** Clears every selection and restores the section to its default,
     *  empty state. Confirms first only when the merchant-configured
     *  threshold is exceeded (0 = never ask), per spec. */
    _handleResetAll() {
      var el = this;
      var count = Object.keys(el.selections).length;
      if (count === 0) return;

      var threshold = el.config.resetConfirmThreshold;
      if (threshold > 0 && count >= threshold) {
        var confirmed = window.confirm('This will clear all ' + count + ' spices from your mix. Continue?');
        if (!confirmed) return;
      }

      Object.keys(el.selections).forEach(function (key) {
        el._removeSelection(key);
      });
      el.selections = {};

      if (el.refs.searchInput) el.refs.searchInput.value = '';
      el.searchTerm = '';
      el._applySearchFilter();

      el._renderSummary();
      el._announce('Your masala mix has been reset.');
    }
  }

  customElements.define('masala-bundle-builder', MasalaBundleBuilder);
})();



