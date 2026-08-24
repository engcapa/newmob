package com.example.single;

import org.junit.Test;
import org.junit.Assert;

public class AppTest {

    @Test
    public void appHasMain() {
        Assert.assertTrue(App.class.getDeclaredMethods().length > 0);
    }

    /** Test source-set target: proves junit is on the test classpath for completion. */
    void testSourceSetTargets() {
        if (false) {
            Asser
        }
    }
}
