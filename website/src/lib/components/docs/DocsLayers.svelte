<script lang="ts">
    import topoMap from '$lib/assets/img/docs/maps/topo.png?enhanced';
    import waymarkedMap from '$lib/assets/img/docs/maps/waymarked.png?enhanced';
</script>

<div class="relative h-80 aspect-square rounded-2xl shadow-xl overflow-clip">
    <enhanced:img src={topoMap} alt="Topo map screenshot." class="absolute" />
    <enhanced:img
        src={waymarkedMap}
        alt="Waymarked Trails map screenshot."
        class="absolute opacity-0 hover:opacity-100 transition-opacity duration-200"
    />
</div>
