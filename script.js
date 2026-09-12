/* =========================================================
   PHYNEX — DIRECT CATEGORY PAGE NAVIGATION
   ========================================================= */

function openCategoryPage(category) {
    const value = String(category || '').trim();

    if (!value) {
        window.location.href = 'categories.html';
        return;
    }

    window.location.href =
        'category.html?category=' + encodeURIComponent(value);
}


/* HERO CATEGORY LINKS */
document.querySelectorAll('.hero-links a[data-category]').forEach(function (link) {
    link.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();

        openCategoryPage(link.dataset.category);
    });
});


/* HOMEPAGE CATEGORY CARDS */
document.querySelectorAll('.category[data-category]').forEach(function (tile) {
    tile.style.cursor = 'pointer';

    tile.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();

        openCategoryPage(tile.dataset.category);
    });
});


/* NAVIGATION CATEGORY BUTTONS */
document.querySelectorAll('.nav-item[data-category]').forEach(function (item) {
    item.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();

        const category = item.dataset.category;

        if (!category || category === 'all') {
            window.location.href = 'categories.html';
            return;
        }

        openCategoryPage(category);
    });
});


/* DYNAMIC CATEGORY CARDS */
function setupCategoryNavigation() {
    document.querySelectorAll('.category[data-category]').forEach(function (tile) {

        if (tile.dataset.categoryNavigationAttached === 'true') {
            return;
        }

        tile.dataset.categoryNavigationAttached = 'true';
        tile.style.cursor = 'pointer';

        tile.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();

            openCategoryPage(tile.dataset.category);
        });
    });
}


if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupCategoryNavigation);
} else {
    setupCategoryNavigation();
}
/* =========================================================
   PHYNEX CATEGORY NAVIGATION FIX
   Opens category pages directly instead of scrolling/filtering
   ========================================================= */

(function () {

    function goToCategory(category) {
        category = String(category || '').trim();

        if (!category || category.toLowerCase() === 'all') {
            window.location.href = 'categories.html';
            return;
        }

        window.location.href =
            'category.html?category=' + encodeURIComponent(category);
    }

    document.addEventListener('click', function (event) {

        /*
         * Homepage category cards
         */
        var categoryCard = event.target.closest(
            '.category[data-category]'
        );

        if (categoryCard) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            goToCategory(categoryCard.getAttribute('data-category'));
            return;
        }

        /*
         * Hero category links
         */
        var heroCategory = event.target.closest(
            '.hero-links a[data-category]'
        );

        if (heroCategory) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            goToCategory(heroCategory.getAttribute('data-category'));
            return;
        }

        /*
         * Category navigation items
         */
        var navCategory = event.target.closest(
            '.nav-item[data-category]'
        );

        if (navCategory) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            goToCategory(navCategory.getAttribute('data-category'));
            return;
        }

    }, true);

})();